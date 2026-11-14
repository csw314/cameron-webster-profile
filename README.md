# Cameron Webster profile

A responsive, dark personal profile built with semantic HTML, CSS, and a small JavaScript module. It introduces Cameron's background, offers a downloadable résumé, and reserves space for future interactive projects. No framework, package installation, external fonts, analytics, API keys, or backend is required.

## Current version

- One page with introduction, capabilities, experience, education, project roadmap, and contact links.
- Downloadable PDF résumé and the original Word version under `assets/documents/`.
- Keyboard navigation, visible focus states, reduced-motion support, responsive layouts, and a complete HTML fallback when JavaScript is disabled.
- Two clearly labeled planned projects: a live data dashboard and an MNIST digit recognition demo. Their visuals are illustrations; they do not fetch live data or run inference.
- An intentional monogram placeholder in the portrait frame. No actual headshot was supplied; the GitHub account currently uses an identicon.

## Preview locally

From the repository directory, run:

```sh
python3 -m http.server 3000
```

Then visit `http://localhost:3000`. Use an HTTP server rather than opening the HTML as a local file, so JavaScript modules can load. `npm run dev` is an alternative on systems with Node; it uses the included dependency-free development server. It accepts `--host` and `--port` options.

## Structure

```text
index.html                       Profile content and no-JavaScript fallback
assets/css/styles.css            Design tokens, layout, responsive styles
assets/js/app.js                 Portrait configuration and project rendering
assets/images/                   Portrait placeholder and favicon
assets/documents/                Downloadable résumé assets
data/profile.js                  Portrait source, alt text, placeholder flag
data/projects.js                 Registry for planned and live project links
scripts/build.mjs                Optional dependency-free static build
scripts/serve.mjs                Optional Node development server
```

## Add the headshot

1. Add a real photograph at `assets/images/cameron-webster.jpg` (ideally at least 800 pixels wide).
2. Update `data/profile.js` with the photo path, descriptive alt text, and `isPlaceholder: false`.
3. Update the default image `src` and `alt` in `index.html` as well, and remove the placeholder caption so the no-JavaScript version stays accurate.

The photo is cropped within the existing frame. Adjust `object-position` in the stylesheet if the crop needs repositioning.

## Update the résumé or profile

Replace `assets/documents/Cameron_Webster_Resume.pdf` and, if desired, the Word file with newer versions, keeping the filenames stable. The original Word document is retained as `Cameron_Webster_Resume.docx`; the PDF was converted from it for convenient browser viewing and download.

Edit biographical copy, experience, education, social links, and email in `index.html`. The initial content is grounded in the supplied résumé. The page does not reproduce the résumé's phone number or clearance details; the downloadable résumé retains the supplied content.

## Add and launch projects

Add entries to `data/projects.js`, using the existing fields as a guide. Keep `status: "planned"` and `url: null` until a demo is actually available. For a finished demo, set `status: "live"`, supply a valid URL, and update the description and category. The page will display a working project link. Relative URLs support projects hosted under this site; HTTPS URLs support separate applications.

Update the corresponding static cards in `index.html` to keep the no-JavaScript experience in sync. Replace the decorative roadmap illustrations with actual screenshots when demos are ready. When projects are launched, also update the roadmap heading and introduction so they accurately describe the available work.

### Live dashboard extension

A future project can be added under `projects/dashboard/` or hosted separately. Give each external feed its own data adapter, display source and refresh time, and show loading and failure states. Put scheduled collection or private credentials on a backend; never commit secrets to the frontend.

### MNIST extension

A future `projects/mnist/` page can contain a drawing canvas, preprocessing, and model inference. Model training can live independently in `models/mnist/`. A small exported model could run in the browser; server inference can use a separate API if needed. Neither training nor inference is implemented in this version.

## Build and hosting

The repository root is directly servable as a static site. If a host expects a build command and output directory:

```sh
npm run build
```

Publish `dist/`. The build copies only the webpage and its assets. The repository remains private and this commit does not configure or publish hosting, enable GitHub Pages, or change repository visibility. Before public launch, add the real portrait and final public URL metadata, and review the downloadable résumé's contact information for public distribution.
