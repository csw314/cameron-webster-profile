import { projects } from "../../data/projects.js?v=20261114-profile-4";
import { initPortraitCarousel } from "./portrait-carousel.js?v=20261114-profile-4";

const year = document.querySelector("#year");
if (year) year.textContent = new Date().getFullYear();

initPortraitCarousel();

// Keep the hand-authored HTML as a complete, useful no-JavaScript fallback.
// Clone its decorative artwork only; all project content comes from the registry.
const projectList = document.querySelector("#project-list");
if (projectList) {
  const visuals = new Map(
    [...projectList.querySelectorAll(".project-visual")].map((node) => [
      node.classList.contains("mnist-visual") ? "mnist" : "dashboard", node,
    ]),
  );
  const fragment = document.createDocumentFragment();
  for (const [index, project] of projects.entries()) {
    const article = document.createElement("article");
    article.className = "project-card";
    article.id = `project-${project.id}`;
    const visual = visuals.get(project.visual);
    if (visual) article.append(visual.cloneNode(true));

    const body = document.createElement("div");
    body.className = "project-body";
    const top = document.createElement("div");
    top.className = "project-card-top";
    const number = document.createElement("span");
    number.className = "project-number";
    number.textContent = `Project ${String(index + 1).padStart(2, "0")}`;
    const badge = document.createElement("span");
    badge.className = "planned-badge";

    // Only enable navigation for live projects with a safe, usable URL.
    let liveUrl = null;
    if (project.status === "live" && project.url) {
      try {
        const parsed = new URL(project.url, window.location.href);
        if (parsed.protocol === "https:" ||
            (parsed.protocol === "http:" && parsed.origin === window.location.origin)) {
          liveUrl = parsed;
        }
      } catch { /* An invalid URL stays a non-clickable preview. */ }
    }
    badge.textContent = liveUrl ? "Live" : "Planned";
    top.append(number, badge);
    const title = document.createElement("h3");
    title.textContent = project.title;
    const description = document.createElement("p");
    description.textContent = project.description;
    const footer = document.createElement("div");
    footer.className = "project-footer";
    const category = document.createElement("span");
    category.textContent = project.category;
    footer.append(category);
    if (liveUrl) {
      article.classList.add("project-card--live");
      const link = document.createElement("a");
      link.href = liveUrl.href;
      link.textContent = "Open project ↗";
      link.setAttribute("aria-label", `Open ${project.title}`);
      if (liveUrl.origin !== window.location.origin) {
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.setAttribute("aria-label", `Open ${project.title} (opens in a new tab)`);
      }
      footer.append(link);
    } else {
      const status = document.createElement("span");
      status.textContent = "Coming soon";
      footer.append(status);
    }
    body.append(top, title, description, footer);
    article.append(body);
    fragment.append(article);
  }
  projectList.replaceChildren(fragment);
}
