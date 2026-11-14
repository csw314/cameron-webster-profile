"""Public inference API. Loads trained weights once; never trains on requests."""
from __future__ import annotations
import asyncio
import base64
import binascii
from contextlib import asynccontextmanager
import hashlib
import io
import json
import os
from pathlib import Path

import numpy as np
from PIL import Image, UnidentifiedImageError
import torch
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field, ValidationError, ConfigDict
from starlette.concurrency import run_in_threadpool

from mnist.network import DigitNet
from mnist.preprocessing import prepare_image, PREPROCESSING_VERSION

ARTIFACTS = Path(__file__).parent / "artifacts"
MAX_BODY_BYTES = 700_000
CHEEKY_MESSAGE = "The instructions were very clear: one digit, 0–9. Your artistic interpretation has been respectfully declined."


class Drawing(BaseModel):
    model_config = ConfigDict(extra="forbid")
    image: str = Field(min_length=1, max_length=650_000, description="Base64-encoded PNG or a PNG data URL, with white strokes on a black background.")


def rejection(reason, model_version):
    return {"accepted": False, "digit": None, "confidence": None, "reason": reason, "message": CHEEKY_MESSAGE, "model_version": model_version}


def decode_image(value):
    if value.startswith("data:"):
        if not value.startswith("data:image/png;base64,"):
            raise HTTPException(422, "Only PNG drawings are supported.")
        value = value.split(",", 1)[1]
    try:
        raw = base64.b64decode(value, validate=True)
        if not raw.startswith(b"\x89PNG\r\n\x1a\n"):
            raise ValueError("Not a PNG")
        with Image.open(io.BytesIO(raw)) as image:
            if image.width > 1024 or image.height > 1024 or min(image.size) < 8:
                raise HTTPException(422, "Drawing dimensions must be between 8 and 1024 pixels.")
            image.load()
            return image.copy()
    except HTTPException:
        raise
    except (ValueError, binascii.Error, UnidentifiedImageError, OSError, Image.DecompressionBombError) as error:
        raise HTTPException(422, "The drawing must be a valid base64-encoded PNG.") from error


def predict(model, metadata, image):
    pixels, geometry = prepare_image(image)
    version = metadata["model_version"]
    if geometry["blank"]:
        return rejection("blank_drawing", version)
    with torch.inference_mode():
        probabilities = model(torch.from_numpy(pixels[None, None])).softmax(1)[0].numpy()
    digit = int(np.argmax(probabilities[:10]))
    confidence = float(probabilities[digit])
    thresholds = metadata["thresholds"]
    if confidence < thresholds["confidence"] or probabilities[10] > thresholds["max_reject_probability"]:
        return rejection("not_a_clear_single_digit", version)
    return {"accepted": True, "digit": digit, "confidence": round(confidence, 5), "reason": None,
            "message": f"That looks like a {digit}.", "model_version": version,
            "scores": [round(float(score), 5) for score in probabilities[:10]],
            "reject_score": round(float(probabilities[10]), 5)}


@asynccontextmanager
async def lifespan(application):
    torch.set_num_threads(max(1, int(os.getenv("TORCH_NUM_THREADS", "1"))))
    metadata = json.loads((ARTIFACTS / "metadata.json").read_text())
    weights_path = ARTIFACTS / "mnist_model.pt"
    if metadata["preprocessing_version"] != PREPROCESSING_VERSION:
        raise RuntimeError("Model and preprocessing versions differ.")
    if hashlib.sha256(weights_path.read_bytes()).hexdigest() != metadata["weights_sha256"]:
        raise RuntimeError("Model weights failed their integrity check.")
    model = DigitNet()
    model.load_state_dict(torch.load(weights_path, map_location="cpu", weights_only=True))
    application.state.model = model.eval()
    application.state.metadata = metadata
    application.state.capacity = asyncio.Semaphore(2)
    yield


app = FastAPI(title="Cameron Webster · MNIST API", version="1.0.0", lifespan=lifespan,
              description="Eleven-class CNN for digits and tested non-digit inputs. Predictions are not stored. Rejection is best effort, not a guarantee for arbitrary drawings.")
origins = [origin.strip() for origin in os.getenv("ALLOWED_ORIGINS", "https://csw314.github.io").split(",") if origin.strip()]
app.add_middleware(CORSMiddleware, allow_origins=origins, allow_methods=["GET", "POST"], allow_headers=["Content-Type"], allow_credentials=False)


@app.get("/")
def index():
    return {"service": "Cameron Webster MNIST inference", "docs": "/docs", "health": "/health", "predict": "POST /predict", "privacy": "Drawings are processed in memory and are not stored by this application."}


@app.get("/health")
def health(request: Request):
    return {"status": "ok", "model_version": request.app.state.metadata["model_version"], "preprocessing_version": PREPROCESSING_VERSION}


@app.get("/model-info")
def model_info(request: Request):
    metadata = request.app.state.metadata
    return {key: metadata[key] for key in ["model_version", "architecture", "parameters", "training_samples", "thresholds", "metrics", "limitations"]}


@app.post("/predict", responses={413: {"description": "Drawing request is too large"}, 422: {"description": "Invalid drawing"}},
          openapi_extra={"requestBody": {"required": True, "content": {"application/json": {"schema": Drawing.model_json_schema()}}}})
async def predict_drawing(request: Request):
    # Bound streamed bodies before allocating a decoded image or running a model.
    body = bytearray()
    async for chunk in request.stream():
        if len(body) + len(chunk) > MAX_BODY_BYTES:
            raise HTTPException(413, "Drawing request is too large.")
        body.extend(chunk)
    try:
        drawing = Drawing.model_validate_json(body)
    except (ValidationError, ValueError) as error:
        raise HTTPException(422, "Send a JSON object with one base64 PNG 'image' field.") from error
    image = decode_image(drawing.image)
    async with request.app.state.capacity:
        return await run_in_threadpool(predict, request.app.state.model, request.app.state.metadata, image)
