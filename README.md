# Cameron Webster profile and ML portfolio

A dark, responsive personal profile with a downloadable résumé and an interactive handwritten-digit project. The profile and drawing interface run on GitHub Pages. A separate FastAPI service serves the trained PyTorch model.

## Profile

The main page introduces Cameron's experience, education, technical skills, and project roadmap. The résumé is available as a PDF; the supplied original Word document is retained under `assets/documents/`. Seven personal photos rotate in the profile card, with each photo and its caption advancing together every eight seconds. Visitors can pause the slideshow or navigate manually. Full photos remain visible across portrait and landscape orientations; reduced-motion preferences disable the transition animation.

## Handwritten Digit Lab

The interface lives at `projects/mnist/`. Visitors can draw with a mouse, finger, or stylus, clear the canvas, or load curated MNIST examples. Predict sends the drawing to the configured service. Accepted results show the predicted digit and top model scores. Rejected drawings receive a cheeky response. Service failures preserve the drawing and display a connection error rather than a rejection.

The included model is trained and evaluated. Its public prediction service is configured at https://cameron-webster-mnist.onrender.com . The homepage links to the working MNIST demo; the live data dashboard remains planned.

| Component | Location |
| --- | --- |
| Profile | `index.html`, `assets/css/`, `assets/js/` |
| Drawing interface | `projects/mnist/` |
| Frontend service URL | `projects/mnist/config.js` |
| Runnable training notebook | `training/train.ipynb` |
| Reproducible training script | `training/train.py` |
| Model card and measured results | `training/MODEL_CARD.md` |
| Shared model and preprocessing | `api/mnist/` |
| Saved checkpoint and metadata | `api/artifacts/` |
| Prediction API | `api/main.py` |
| API deployment details | `api/README.md` |
| Optional Render Blueprint | `render.yaml` |
| End-to-end API tests | `tests/test_api.py` |

## Preview the frontend

No dependencies need to be installed for the static page:

```sh
python3 -m http.server 3000
```

Open `http://localhost:3000` for the profile or `http://localhost:3000/projects/mnist/` for the demo. Use an HTTP server instead of opening HTML from a local file, because JavaScript modules require HTTP. Alternatively, `npm run dev` starts the included dependency-free Node development server.

## Train or retrain

The checked-in checkpoint was trained on MNIST digits, EMNIST letters, and generated invalid drawings. Validation selects the checkpoint and rejection thresholds; separate test sets measure recognition and rejection. The training notebook walks through the same script and plots the results.

```sh
python -m pip install -r training/requirements.txt
python training/train.py --epochs 8 --seed 42 --threads 4
```

The script downloads raw datasets into `.cache/datasets/`, which is excluded from Git. Do not commit those datasets. See the model card for attribution, split sizes, selection methods, and limitations.

## Run the API

```sh
python -m pip install -r api/requirements.txt
python -m uvicorn main:app --app-dir api --host 127.0.0.1 --port 8000
```

API reference: `http://127.0.0.1:8000/docs`. Production CORS allows `https://csw314.github.io`; configure `ALLOWED_ORIGINS` for additional development origins. Never put credentials into frontend JavaScript. The API processes images in memory and does not save drawings or use them for training.

## Test

With API dependencies and `httpx` installed:

```sh
python -m unittest discover -s tests -v
npm run build
```

Tests exercise the real checkpoint, all ten curated examples, blank and multi-digit inputs, invalid drawings, malformed and oversized requests, model metadata, and CORS. They are behavior checks, not a substitute for the separate model evaluation.

## Publish

GitHub Pages can deploy the repository root from `main`; `.nojekyll` is included. For another static host, `npm run build` copies the profile and project pages to `dist/` without the API, training files, or tests.

Deploy the API separately to Render using the commands in `api/README.md` or the schema-validated root Blueprint. Verify health and actual inference before adding the exact service URL to `projects/mnist/config.js`. Then mark the MNIST entry live in `data/projects.js` and update its static fallback card and the roadmap introduction in `index.html`. The live data dashboard remains planned.

Render's free service can sleep while idle. The demo handles delayed or failed requests explicitly; an always-on compute plan can be selected later if desired.

## Maintain the profile

- Replace `assets/documents/Cameron_Webster_Resume.pdf` to update the download, keeping the filename stable.
- Manage photo order, captions, locations, alt text, and the eight-second interval in `data/profile.js`. Store optimized photos under `assets/images/profile/`. Keep the first static slide in `index.html` in sync so the no-JavaScript fallback stays accurate. The slideshow logic lives in `assets/js/portrait-carousel.js`.
- Edit profile copy and social links in `index.html`.
- Add future project links in `data/projects.js`, keeping Planned status until the corresponding experience works.

## Data attribution

MNIST copyright Yann LeCun and Corinna Cortes; included transformed sample images are CC BY-SA 3.0. EMNIST: Cohen et al. (2017), from NIST. Raw datasets are not redistributed. Full sources and evaluation details are in `training/MODEL_CARD.md`.
