import { portraits, portraitIntervalMs } from "../../data/profile.js?v=20261114-bikeshare-1";

export function initPortraitCarousel() {
  const carousel = document.querySelector("#portrait-carousel");
  if (!carousel || portraits.length === 0) return;

  const viewport = carousel.querySelector(".portrait-viewport");
  const controls = carousel.querySelector(".portrait-controls");
  const counter = carousel.querySelector("[data-portrait-count]");
  const pauseButton = carousel.querySelector("[data-portrait-pause]");
  const fragment = document.createDocumentFragment();

  const slides = portraits.map((portrait, index) => {
    const slide = document.createElement("figure");
    slide.className = `portrait-slide${index === 0 ? " is-active" : ""}`;
    slide.setAttribute("role", "group");
    slide.setAttribute("aria-roledescription", "slide");
    slide.setAttribute("aria-label", `${index + 1} of ${portraits.length}`);
    slide.setAttribute("aria-hidden", String(index !== 0));

    const imageWrap = document.createElement("div");
    imageWrap.className = "portrait-image-wrap";
    const image = document.createElement("img");
    image.src = portrait.src;
    image.alt = portrait.alt;
    image.width = portrait.width;
    image.height = portrait.height;
    // Preload every slide so its photo is ready before its eight-second turn.
    image.loading = "eager";
    image.decoding = "async";
    image.fetchPriority = index === 0 ? "high" : "low";
    imageWrap.append(image);

    const caption = document.createElement("figcaption");
    const description = document.createElement("p");
    description.textContent = portrait.caption;
    const location = document.createElement("span");
    location.className = "portrait-location";
    location.textContent = portrait.location;
    caption.append(description, location);
    slide.append(imageWrap, caption);
    fragment.append(slide);
    return slide;
  });

  viewport.replaceChildren(fragment);
  controls.hidden = portraits.length < 2;

  let activeIndex = 0;
  let playing = true;
  let ready = false;
  let timer = null;
  let remaining = portraitIntervalMs;
  let deadline = 0;

  function showSlide(index) {
    slides[activeIndex].classList.remove("is-active");
    slides[activeIndex].setAttribute("aria-hidden", "true");
    activeIndex = (index + slides.length) % slides.length;
    slides[activeIndex].classList.add("is-active");
    slides[activeIndex].setAttribute("aria-hidden", "false");
    counter.textContent = `${String(activeIndex + 1).padStart(2, "0")} / ${String(slides.length).padStart(2, "0")}`;
  }

  function clearTimer() {
    window.clearTimeout(timer);
    timer = null;
  }

  function schedule() {
    clearTimer();
    if (!ready || !playing || document.hidden || slides.length < 2) return;
    deadline = performance.now() + remaining;
    timer = window.setTimeout(() => {
      showSlide(activeIndex + 1);
      remaining = portraitIntervalMs;
      schedule();
    }, remaining);
  }

  function suspend() {
    if (timer !== null) remaining = Math.max(0, deadline - performance.now());
    clearTimer();
  }

  function navigate(offset) {
    showSlide(activeIndex + offset);
    remaining = portraitIntervalMs;
    schedule();
  }

  carousel.querySelector("[data-portrait-previous]").addEventListener("click", () => navigate(-1));
  carousel.querySelector("[data-portrait-next]").addEventListener("click", () => navigate(1));
  pauseButton.addEventListener("click", () => {
    playing = !playing;
    pauseButton.textContent = playing ? "Pause" : "Play";
    pauseButton.setAttribute("aria-label", playing ? "Pause slideshow" : "Play slideshow");
    viewport.setAttribute("aria-live", playing ? "off" : "polite");
    if (playing) schedule();
    else suspend();
  });

  // Keep a slide's remaining viewing time when the visitor switches tabs.
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) suspend();
    else schedule();
  });

  showSlide(0);
  const firstImage = slides[0].querySelector("img");
  firstImage.decode().catch(() => {}).finally(() => {
    ready = true;
    schedule();
  });
}
