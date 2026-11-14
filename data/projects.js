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
    id: "live-dashboard",
    title: "Live data dashboard",
    status: "planned",
    category: "Data engineering / Visualization",
    description: "A planned dashboard connecting a live data feed to a pipeline and interactive visualizations.",
    visual: "dashboard",
    url: null,
  },
  {
    id: "mnist",
    title: "Handwritten digit recognition",
    status: "planned",
    category: "Machine learning / Computer vision",
    description: "A planned demo where you draw a digit and a computer vision model trained on MNIST predicts the number.",
    visual: "mnist",
    url: null,
  },
];
