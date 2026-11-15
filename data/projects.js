/**
 * Project registry. Planned projects have no live URL and render as non-clickable
 * previews. To launch a project, set status to "live", add a URL, and update its
 * description and technologies to match the finished implementation.
 *
 * Live URLs may be relative (e.g. "projects/mnist/") or HTTPS URLs on another
 * host. A future inference API can live independently of this static profile.
 */
export const projects = [
  {
    "id": "mnist",
    "title": "Handwritten digit recognition",
    "status": "live",
    "category": "Machine learning / Computer vision",
    "description": "Draw a single digit and get a prediction from a trained CNN, with a cheeky response for drawings the model rejects.",
    "visual": "mnist",
    "url": "projects/mnist/"
  },
  {
    "id": "live-dashboard",
    "title": "Capital Bikeshare dispatch",
    "status": "live",
    "category": "Data engineering / Operations research",
    "description": "Use live station inventory to plan a bike transfer in the DC region, then replay a recorded commute to see which stations ran short.",
    "visual": "dashboard",
    "url": "projects/bikeshare/"
  }
];
