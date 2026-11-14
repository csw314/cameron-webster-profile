"""A compact eleven-class CNN: ten digits plus a rejection class."""
import torch
from torch import nn


class DigitNet(nn.Module):
    def __init__(self):
        super().__init__()
        self.features = nn.Sequential(
            nn.Conv2d(1, 16, 3, padding=1), nn.ReLU(), nn.MaxPool2d(2),
            nn.Conv2d(16, 32, 3, padding=1), nn.ReLU(), nn.MaxPool2d(2),
        )
        self.classifier = nn.Sequential(
            nn.Flatten(), nn.Linear(32 * 7 * 7, 64), nn.ReLU(),
            nn.Dropout(0.2), nn.Linear(64, 11),
        )

    def forward(self, images):
        return self.classifier(self.features(images))
