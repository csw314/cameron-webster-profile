"""Train, calibrate, evaluate, and export the MNIST demo without notebook state.

Run from the repository root: python training/train.py --data-dir .cache/datasets
The final test sets are evaluated only after selecting the checkpoint and gate
using validation data. No training data or external tracking service is uploaded.
"""
from __future__ import annotations
import argparse
import copy
import gzip
import hashlib
import io
import json
import math
from pathlib import Path
import random
import sys
import time
import urllib.request
import zipfile

import numpy as np
from PIL import Image, ImageDraw
import torch
from torch import nn
from torch.utils.data import DataLoader, TensorDataset

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "api"))
from mnist.network import DigitNet
from mnist.preprocessing import prepare_image, PREPROCESSING_VERSION

MNIST_URL = "https://storage.googleapis.com/tensorflow/tf-keras-datasets/mnist.npz"
EMNIST_URL = "https://biometrics.nist.gov/cs_links/EMNIST/gzip.zip"
AMBIGUOUS_LETTERS = [9, 12, 15]  # I, L, O can be indistinguishable from 1 or 0.


def download(url, path):
    if not path.exists():
        print(f"Downloading {path.name}", flush=True)
        temporary = path.with_suffix(".download")
        urllib.request.urlretrieve(url, temporary)
        temporary.replace(path)


def idx_member(archive, name, images=False):
    with archive.open("gzip/" + name) as f:
        raw = gzip.decompress(f.read())
    return np.frombuffer(raw, dtype=np.uint8, offset=16 if images else 8).reshape((-1, 28, 28) if images else (-1,)).copy()


def prepare_many(images):
    return np.stack([prepare_image(Image.fromarray(image))[0] for image in images])


def synthetic_negatives(source_digits, count, seed):
    rng = np.random.default_rng(seed)
    images, kinds = [], []
    for index in range(count):
        kind = ["multiple_digits", "scribble", "shape", "noise"][index % 4]
        canvas = Image.new("L", (80, 80))
        draw = ImageDraw.Draw(canvas)
        if kind == "multiple_digits":
            for x in [5, 42]:
                digit = Image.fromarray(source_digits[rng.integers(len(source_digits))]).resize((30, 48))
                canvas.paste(digit, (x, int(rng.integers(10, 22))))
        elif kind == "scribble":
            points = [(int(rng.integers(8, 72)), int(rng.integers(8, 72))) for _ in range(int(rng.integers(7, 18)))]
            draw.line(points, fill=255, width=int(rng.integers(2, 6)), joint="curve")
        elif kind == "shape":
            variant = int(rng.integers(4))
            if variant == 0:
                draw.rectangle((12, 15, 66, 65), outline=255, width=4)
            elif variant == 1:
                draw.polygon([(40, 8), (71, 67), (10, 67), (40, 8)], outline=255, width=4)
            elif variant == 2:
                draw.line((10, 10, 68, 68), fill=255, width=4); draw.line((10, 68, 68, 10), fill=255, width=4)
            else:
                draw.line((12, 40, 67, 40), fill=255, width=4); draw.line((40, 12, 40, 67), fill=255, width=4)
        else:
            noise = (rng.random((80, 80)) < rng.uniform(.02, .12)).astype(np.uint8) * 255
            canvas = Image.fromarray(noise)
        images.append(prepare_image(canvas)[0]); kinds.append(kind)
    return np.stack(images), kinds


def make_loaders(x, y, batch_size=256, shuffle=False):
    return DataLoader(TensorDataset(torch.from_numpy(x[:, None]), torch.from_numpy(y.astype(np.int64))), batch_size=batch_size, shuffle=shuffle, num_workers=0)


@torch.inference_mode()
def probabilities(model, x, batch_size=512):
    model.eval()
    result = []
    for offset in range(0, len(x), batch_size):
        result.append(model(torch.from_numpy(x[offset:offset + batch_size, None])).softmax(1).cpu().numpy())
    return np.concatenate(result)


def gate(probabilities, confidence, max_reject):
    return (probabilities[:, :10].max(1) >= confidence) & (probabilities[:, 10] <= max_reject)


def calibrate(valid_probs, valid_labels, invalid_probs):
    candidates = []
    for confidence in np.arange(.5, .951, .025):
        for max_reject in [.05, .1, .15, .2, .3, .4]:
            accepted = gate(valid_probs, confidence, max_reject)
            coverage = accepted.mean()
            accuracy = (valid_probs[:, :10].argmax(1)[accepted] == valid_labels[accepted]).mean() if accepted.any() else 0
            rejection = 1 - gate(invalid_probs, confidence, max_reject).mean()
            candidates.append((coverage >= .97 and accuracy >= .985, rejection + .25 * coverage, coverage, accuracy, rejection, confidence, max_reject))
    feasible = [candidate for candidate in candidates if candidate[0]]
    # If the desired coverage/accuracy constraints cannot both be met, maximize
    # balanced validation performance. Record the achieved values transparently.
    best = max(feasible, key=lambda c: c[1]) if feasible else max(candidates, key=lambda c: .5 * c[2] + .5 * c[4])
    return {"confidence": round(float(best[5]), 3), "max_reject_probability": float(best[6]), "validation_digit_acceptance_rate": float(best[2]), "validation_accepted_digit_accuracy": float(best[3]), "validation_negative_rejection_rate": float(best[4]), "coverage_target_met": bool(best[0])}


def evaluate(valid_probs, labels, negative_probs, kinds, threshold):
    accepted = gate(valid_probs, threshold["confidence"], threshold["max_reject_probability"])
    predictions = valid_probs[:, :10].argmax(1)
    rejected = ~gate(negative_probs, threshold["confidence"], threshold["max_reject_probability"])
    confusion = np.zeros((10, 10), dtype=int)
    np.add.at(confusion, (labels, predictions), 1)
    return {
        "mnist_test_count": len(labels), "digit_accuracy_before_rejection": float((predictions == labels).mean()),
        "digit_acceptance_rate": float(accepted.mean()),
        "accepted_digit_accuracy": float((predictions[accepted] == labels[accepted]).mean()),
        "negative_test_count": len(kinds), "negative_rejection_rate": float(rejected.mean()),
        "negative_rejection_by_category": {kind: {"count": kinds.count(kind), "rejection_rate": float(rejected[np.asarray(kinds) == kind].mean())} for kind in sorted(set(kinds))},
        "confusion_matrix_before_rejection": confusion.tolist(),
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-dir", type=Path, default=ROOT / ".cache/datasets")
    parser.add_argument("--epochs", type=int, default=8)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--threads", type=int, default=4)
    args = parser.parse_args()
    torch.set_num_threads(args.threads)
    torch.manual_seed(args.seed); np.random.seed(args.seed); random.seed(args.seed)
    args.data_dir.mkdir(parents=True, exist_ok=True)
    download(MNIST_URL, args.data_dir / "mnist.npz")
    download(EMNIST_URL, args.data_dir / "emnist.zip")
    output = ROOT / "api/artifacts"; output.mkdir(parents=True, exist_ok=True)
    dataset = np.load(args.data_dir / "mnist.npz", allow_pickle=False)
    train_raw, labels_raw = dataset["x_train"], dataset["y_train"]
    rng = np.random.default_rng(args.seed)
    validation_index = np.concatenate([rng.choice(np.where(labels_raw == label)[0], 500, replace=False) for label in range(10)])
    train_index = np.setdiff1d(np.arange(len(train_raw)), validation_index)
    print("Preprocessing MNIST", flush=True)
    train_digits = prepare_many(train_raw[train_index]); val_digits = prepare_many(train_raw[validation_index])
    with zipfile.ZipFile(args.data_dir / "emnist.zip") as archive:
        letters_train_raw = idx_member(archive, "emnist-letters-train-images-idx3-ubyte.gz", True).transpose(0, 2, 1)
        letters_train_labels = idx_member(archive, "emnist-letters-train-labels-idx1-ubyte.gz")
        letter_indices = rng.permutation(np.where(~np.isin(letters_train_labels, AMBIGUOUS_LETTERS))[0])
        train_letters = prepare_many(letters_train_raw[letter_indices[:24000]])
        val_letters = prepare_many(letters_train_raw[letter_indices[24000:28000]])
    train_synthetic, _ = synthetic_negatives(train_raw[train_index], 12000, args.seed + 1)
    val_synthetic, _ = synthetic_negatives(train_raw[validation_index], 2400, args.seed + 2)
    train_x = np.concatenate([train_digits, train_letters, train_synthetic])
    train_y = np.concatenate([labels_raw[train_index], np.full(len(train_letters) + len(train_synthetic), 10)])
    val_invalid = np.concatenate([val_letters, val_synthetic])
    loader = make_loaders(train_x, train_y, shuffle=True)
    model = DigitNet()
    optimizer = torch.optim.AdamW(model.parameters(), lr=.0015, weight_decay=.0001)
    loss_fn = nn.CrossEntropyLoss(weight=torch.tensor([1.] * 10 + [.4]))
    history, best_score, best_state, selected_epoch = [], -1, None, None
    started = time.time()
    for epoch in range(args.epochs):
        model.train(); total_loss = 0
        for x, y in loader:
            # Small translations/rotations approximate variability in cursor input.
            angles = (torch.rand(len(x)) - .5) * .3
            theta = torch.zeros(len(x), 2, 3)
            theta[:, 0, 0] = angles.cos(); theta[:, 1, 1] = angles.cos()
            theta[:, 0, 1] = -angles.sin(); theta[:, 1, 0] = angles.sin()
            theta[:, :, 2] = (torch.rand(len(x), 2) - .5) * .15
            x = nn.functional.grid_sample(x, nn.functional.affine_grid(theta, x.shape, align_corners=False), align_corners=False)
            optimizer.zero_grad(set_to_none=True)
            loss = loss_fn(model(x), y); loss.backward(); optimizer.step()
            total_loss += loss.item() * len(x)
        valid_probs = probabilities(model, val_digits)
        invalid_probs = probabilities(model, val_invalid)
        digit_accuracy = (valid_probs.argmax(1) == labels_raw[validation_index]).mean()
        invalid_accuracy = (invalid_probs.argmax(1) == 10).mean()
        score = .75 * digit_accuracy + .25 * invalid_accuracy
        record = {"epoch": epoch + 1, "loss": total_loss / len(train_x), "validation_digit_accuracy_including_reject_class": float(digit_accuracy), "validation_negative_rejection_argmax": float(invalid_accuracy), "elapsed_seconds": round(time.time() - started, 1)}
        history.append(record); print(json.dumps(record), flush=True)
        if score > best_score:
            best_score = score; best_state = copy.deepcopy(model.state_dict()); selected_epoch = epoch + 1
    model.load_state_dict(best_state); model.eval()
    threshold = calibrate(probabilities(model, val_digits), labels_raw[validation_index], probabilities(model, val_invalid))
    print("Checkpoint and thresholds selected; evaluating held-out test sets", flush=True)
    test_digits = prepare_many(dataset["x_test"])
    with zipfile.ZipFile(args.data_dir / "emnist.zip") as archive:
        letters_test_raw = idx_member(archive, "emnist-letters-test-images-idx3-ubyte.gz", True).transpose(0, 2, 1)
        letters_test_labels = idx_member(archive, "emnist-letters-test-labels-idx1-ubyte.gz")
        test_letter_indices = np.random.default_rng(args.seed + 3).permutation(np.where(~np.isin(letters_test_labels, AMBIGUOUS_LETTERS))[0])[:5000]
        test_letters = prepare_many(letters_test_raw[test_letter_indices])
    test_synthetic, synthetic_kinds = synthetic_negatives(dataset["x_test"], 4000, args.seed + 4)
    negative_test = np.concatenate([test_letters, test_synthetic])
    metrics = evaluate(probabilities(model, test_digits), dataset["y_test"], probabilities(model, negative_test), ["handwritten_letter"] * len(test_letters) + synthetic_kinds, threshold)
    weights_file = output / "mnist_model.pt"
    torch.save(model.state_dict(), weights_file)
    metadata = {"model_version": "mnist-reject-cnn-v1", "architecture": "Conv16-Pool-Conv32-Pool-Dense64-Dense11", "classes": list(map(str, range(10))) + ["reject"], "parameters": sum(p.numel() for p in model.parameters()), "preprocessing_version": PREPROCESSING_VERSION, "seed": args.seed, "epochs": args.epochs, "torch_version": torch.__version__, "training_samples": {"mnist_digits": len(train_digits), "emnist_letters": len(train_letters), "synthetic_negatives": len(train_synthetic)}, "excluded_emnist_letters": ["I", "L", "O"], "thresholds": threshold, "metrics": metrics, "history": history, "weights_sha256": hashlib.sha256(weights_file.read_bytes()).hexdigest(), "dataset_sha256": {name: hashlib.sha256((args.data_dir / name).read_bytes()).hexdigest() for name in ["mnist.npz", "emnist.zip"]}, "dataset_sources": {"mnist": MNIST_URL, "emnist": EMNIST_URL}, "limitations": ["Rejects a tested set of non-digit inputs, not every possible out-of-distribution image.", "Letters I, L and O are excluded because they may be visually identical to digits.", "MNIST test scores do not measure performance on all cursor or touchscreen handwriting styles.", "Softmax confidence is a model score, not a calibrated probability of correctness."]}
    metadata["selected_epoch"] = selected_epoch
    (output / "metadata.json").write_text(json.dumps(metadata, indent=2) + "\n")
    # Public demo examples are selected only after evaluation and never used in training.
    examples_dir = ROOT / "projects/mnist/examples"; examples_dir.mkdir(parents=True, exist_ok=True)
    examples = []
    for label in range(10):
        # Curated examples demonstrate the UI; they are not a benchmark. Choose
        # an accepted example after resizing it exactly as it will be served.
        for index in np.where(dataset["y_test"] == label)[0]:
            image = Image.fromarray(dataset["x_test"][index]).resize((320, 320), Image.Resampling.LANCZOS)
            scores = probabilities(model, prepare_many([np.asarray(image)]))
            if gate(scores, threshold["confidence"], threshold["max_reject_probability"])[0] and scores[0, :10].argmax() == label:
                image.save(examples_dir / f"digit-{label}.png")
                examples.append({"label": label, "test_index": int(index), "selection": "first correctly accepted resized example; not an evaluation sample"})
                break
    (output / "examples.json").write_text(json.dumps(examples, indent=2) + "\n")
    print(json.dumps({"thresholds": threshold, "metrics": metrics}, indent=2), flush=True)


if __name__ == "__main__":
    main()
