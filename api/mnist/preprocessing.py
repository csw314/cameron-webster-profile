"""Deterministic white-ink-on-black preprocessing, shared with training."""
import numpy as np
from PIL import Image

PREPROCESSING_VERSION = "crop20-center-of-mass28-v1"


def prepare_image(image: Image.Image):
    if image.mode == "RGBA":
        background = Image.new("RGBA", image.size, (0, 0, 0, 255))
        image = Image.alpha_composite(background, image)
    image = image.convert("L")
    original = np.asarray(image)
    ys, xs = np.where(original > 32)
    if len(xs) < 8:
        return np.zeros((28, 28), dtype=np.float32), {"blank": True, "aspect_ratio": 0.0}
    left, right, top, bottom = int(xs.min()), int(xs.max() + 1), int(ys.min()), int(ys.max() + 1)
    width, height = right - left, bottom - top
    scale = 20 / max(width, height)
    cropped = image.crop((left, top, right, bottom)).resize(
        (max(1, round(width * scale)), max(1, round(height * scale))), Image.Resampling.LANCZOS
    )
    output = np.zeros((28, 28), dtype=np.float32)
    pixels = np.asarray(cropped, dtype=np.float32) / 255
    y0, x0 = (28 - pixels.shape[0]) // 2, (28 - pixels.shape[1]) // 2
    output[y0:y0 + pixels.shape[0], x0:x0 + pixels.shape[1]] = pixels
    mass = float(output.sum())
    if mass:
        yy, xx = np.indices(output.shape)
        dx = int(np.round(13.5 - float((xx * output).sum()) / mass))
        dy = int(np.round(13.5 - float((yy * output).sum()) / mass))
        shifted = np.zeros_like(output)
        sx0, sx1 = max(0, -dx), min(28, 28 - dx)
        sy0, sy1 = max(0, -dy), min(28, 28 - dy)
        if sx1 > sx0 and sy1 > sy0:
            shifted[sy0 + dy:sy1 + dy, sx0 + dx:sx1 + dx] = output[sy0:sy1, sx0:sx1]
        output = shifted
    return output, {"blank": False, "aspect_ratio": width / height}
