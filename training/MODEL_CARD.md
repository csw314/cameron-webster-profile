# Handwritten digit model

## Purpose

An interactive portfolio demo that classifies a drawing as one digit from 0 through 9, or returns a rejection. It is a demonstration of training, evaluation, model packaging, API serving, and frontend integration. It is not intended for consequential decisions or arbitrary-image recognition.

## Model and preprocessing

- PyTorch convolutional network with 105,931 parameters.
- Architecture: 3×3 convolution (16 channels), ReLU, 2×2 max pooling, 3×3 convolution (32 channels), ReLU, 2×2 max pooling, dense layer (64 units), dropout during training, and 11 output logits.
- Classes: digits 0–9 plus a learned rejection class.
- White strokes on a black background. Crop around ink, preserve aspect ratio while fitting within 20×20 pixels, place on a 28×28 image, and center using ink mass. Pixel values are scaled to [0, 1].
- The API and training import the same preprocessing function. Blank input is rejected before inference.
- The API loads weights once, verifies their SHA-256 hash, sets evaluation mode, and disables gradient tracking for inference.

## Training and selection

The included run used seed 42, eight epochs, AdamW, a weighted cross-entropy loss, batch size 256, and small random translations and rotations. The checkpoint from epoch 6 was selected using validation performance. Training ran on CPU with four threads.

| Data | Training | Validation | Test |
| --- | ---: | ---: | ---: |
| MNIST digits | 55,000 | 5,000 | 10,000 |
| EMNIST handwritten letters | 24,000 | 4,000 | 5,000 |
| Generated invalid drawings | 12,000 | 2,400 | 4,000 |

MNIST validation indices are a deterministic stratified split from the official training set. EMNIST training and validation indices are disjoint; letter tests come from the official EMNIST test set. Generated invalid examples use separate random seeds and source digits from the corresponding split. I, L, and O are excluded from letter negatives because they can be visually indistinguishable from digits.

The validation gate requires a top digit score of at least 0.525 and a rejection score no greater than 0.05. Threshold search aims for at least 97% validation digit acceptance and 98.5% accepted-digit accuracy, then maximizes invalid rejection with a small coverage preference. The test set is evaluated after selection.

## Measured held-out results

| Metric | Result |
| --- | ---: |
| MNIST accuracy before rejection | 98.66% |
| Valid digit acceptance rate | 97.16% |
| Accuracy among accepted valid digits | 99.07% |
| Overall tested non-digit rejection rate | 96.43% |
| Handwritten letter rejection | 94.68% |
| Generated multi-digit rejection | 100.00% |
| Generated scribble rejection | 94.50% |
| Generated shape rejection | 100.00% |
| Generated noise rejection | 100.00% |

Accuracy before rejection selects the top score among the ten digit classes. Acceptance additionally considers the learned rejection output. The full ten-by-ten confusion matrix, epoch history, dataset hashes, thresholds, and weights hash are in `api/artifacts/metadata.json`.

The test digits are processed with the same normalization used by the demo. These are not scores for every possible cursor or touchscreen handwriting style. The 100% results apply only to each defined set of 1,000 generated examples, not to all multi-digit drawings, shapes, or noise.

## Limits

The rejection mechanism is best effort. A non-digit may resemble a digit and pass the gate; valid but unusual handwriting may be rejected. Unseen invalid-input distributions can behave differently. Softmax scores are not calibrated probabilities of correctness. No classifier can reliably infer whether an identical stroke was intended as the letter O or the digit zero.

The sample buttons use curated MNIST test images selected after evaluation for a clear interface demonstration. Their exact source indices and selection policy are recorded in `api/artifacts/examples.json`. They are not training examples and are not a separate evaluation benchmark.

## Data handling

The application processes incoming PNGs in memory. It does not save drawings, send them to an external model provider, or use them to retrain. The hosting provider still handles normal infrastructure traffic and access logs.

## Reproduce

From the repository root:

```sh
python -m pip install -r training/requirements.txt
python training/train.py --epochs 8 --seed 42 --threads 4
```

Or use `training/train.ipynb`. The datasets are downloaded into an ignored cache. The script writes the checkpoint and metadata to `api/artifacts/`. Retraining can change floating-point results across platforms or library versions. The saved checkpoint and hash identify the exact deployed run.

## Sources and attribution

- MNIST: https://keras.io/api/datasets/mnist/ and https://yann.lecun.org/exdb/mnist/ . Copyright Yann LeCun and Corinna Cortes. The included transformed MNIST example images are distributed under CC BY-SA 3.0: https://creativecommons.org/licenses/by-sa/3.0/ .
- EMNIST: https://www.nist.gov/itl/products-and-services/emnist-dataset . Cohen, Afshar, Tapson, and van Schaik (2017), *EMNIST: an extension of MNIST to handwritten letters*, https://arxiv.org/abs/1702.05373 . Raw EMNIST data are downloaded for training and are not redistributed in the repository.
