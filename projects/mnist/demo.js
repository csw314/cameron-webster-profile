import { API_BASE_URL } from "./config.js";

const canvas = document.querySelector("#drawing");
const ctx = canvas.getContext("2d", { willReadFrequently: true });
const predictButton = document.querySelector("#predict");
const clearButton = document.querySelector("#clear");
const hint = document.querySelector("#canvas-hint");
const result = document.querySelector("#result");
const scores = document.querySelector("#scores");
const exampleButtons = [...document.querySelectorAll("[data-digit]")];
document.querySelector("#year").textContent = new Date().getFullYear();
let activePointer = null;
let busy = false;
let exampleRevision = 0;

function resetDrawing() {
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  hint.hidden = false;
  activePointer = null;
}
function showResult(kind, symbol, title, message) {
  result.className = `result-content ${kind}`;
  const glyph = document.createElement("span");
  glyph.className = "result-symbol";
  glyph.setAttribute("aria-hidden", "true");
  glyph.textContent = symbol;
  const heading = document.createElement("h2"); heading.textContent = title;
  const paragraph = document.createElement("p"); paragraph.textContent = message;
  result.replaceChildren(glyph, heading, paragraph);
  scores.hidden = true;
  scores.replaceChildren();
}
function resetResult() {
  showResult("", "?", "What will you draw?", "Sketch a digit and hit Predict. The model will take it from there.");
}
function coordinates(event) {
  const rect = canvas.getBoundingClientRect();
  return { x: (event.clientX - rect.left) * canvas.width / rect.width, y: (event.clientY - rect.top) * canvas.height / rect.height };
}
canvas.addEventListener("pointerdown", (event) => {
  if (busy || activePointer !== null || (event.pointerType === "mouse" && event.button !== 0)) return;
  exampleRevision++;
  event.preventDefault(); canvas.setPointerCapture(event.pointerId); activePointer = event.pointerId;
  hint.hidden = true; resetResult();
  const { x, y } = coordinates(event);
  ctx.strokeStyle = "#fff"; ctx.fillStyle = "#fff"; ctx.lineWidth = 20; ctx.lineCap = "round"; ctx.lineJoin = "round";
  ctx.beginPath(); ctx.arc(x, y, 10, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.moveTo(x, y);
});
canvas.addEventListener("pointermove", (event) => {
  if (event.pointerId !== activePointer || busy) return;
  event.preventDefault(); const { x, y } = coordinates(event); ctx.lineTo(x, y); ctx.stroke();
});
function endStroke(event) {
  if (event.pointerId !== activePointer) return;
  activePointer = null; ctx.closePath();
  if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
}
canvas.addEventListener("pointerup", endStroke);
canvas.addEventListener("pointercancel", endStroke);
canvas.addEventListener("lostpointercapture", () => { activePointer = null; });
clearButton.addEventListener("click", () => { exampleRevision++; resetDrawing(); resetResult(); });

for (const button of exampleButtons) button.addEventListener("click", async () => {
  if (busy) return;
  const revision = ++exampleRevision;
  const image = new Image();
  image.src = `examples/digit-${button.dataset.digit}.png`;
  try {
    await image.decode();
    if (revision !== exampleRevision || busy) return;
    resetDrawing(); ctx.imageSmoothingEnabled = true; ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    hint.hidden = true; resetResult();
  } catch {
    if (revision === exampleRevision) showResult("error", "!", "Example unavailable", "You can still draw your own digit in the box.");
  }
});

function showScores(values) {
  const top = values.map((score, digit) => ({ score, digit })).sort((a, b) => b.score - a.score).slice(0, 3);
  for (const { score, digit } of top) {
    const row = document.createElement("div"); row.className = "score-row";
    const label = document.createElement("span"); label.textContent = digit;
    const track = document.createElement("div"); track.className = "score-track";
    const fill = document.createElement("div"); fill.className = "score-fill"; fill.style.width = `${Math.max(0, Math.min(1, score)) * 100}%`;
    track.append(fill);
    const value = document.createElement("span"); value.textContent = `${(score * 100).toFixed(1)}%`;
    row.append(label, track, value); scores.append(row);
  }
  const note = document.createElement("p"); note.textContent = "TOP DIGIT SCORES · Model scores are not calibrated probabilities.";
  scores.append(note); scores.hidden = false;
}

predictButton.addEventListener("click", async () => {
  if (busy) return;
  if (!API_BASE_URL) {
    showResult("error", "!", "Model service pending deployment", "The drawing interface is ready. Prediction will be enabled when the hosted model is connected."); return;
  }
  if (!hint.hidden) {
    showResult("rejected", "!", "An ambitious drawing of nothing.", "The instructions were very clear: one digit, 0–9. Draw something first, then hit Predict."); return;
  }
  const image = canvas.toDataURL("image/png");
  busy = true; exampleRevision++; activePointer = null;
  predictButton.disabled = true; clearButton.disabled = true; exampleButtons.forEach(button => { button.disabled = true; });
  predictButton.textContent = "Predicting…";
  showResult("loading", "···", "Reading your handwriting", "Sending your drawing to the hosted model.");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 110_000);
  const waking = setTimeout(() => showResult("loading", "···", "Giving the model a moment", "The prediction service may be waking up. Your drawing is still here."), 8_000);
  try {
    const response = await fetch(`${API_BASE_URL.replace(/\/$/, "")}/predict`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ image }), signal: controller.signal, credentials: "omit" });
    if (!response.ok) throw new Error(`Prediction request failed (${response.status})`);
    const data = await response.json();
    if (typeof data.accepted !== "boolean") throw new Error("Invalid prediction response");
    if (data.accepted) {
      if (!Number.isInteger(data.digit) || data.digit < 0 || data.digit > 9 || !Array.isArray(data.scores) || data.scores.length !== 10 || data.scores.some(value => !Number.isFinite(value) || value < 0 || value > 1)) throw new Error("Invalid prediction response");
      showResult("accepted", String(data.digit), `That looks like a ${data.digit}.`, "One digit. Instructions followed. Nicely done.");
      showScores(data.scores);
    } else {
      showResult("rejected", "!", "Let’s revisit the instructions.", data.message || "The instructions were very clear: one digit, 0–9. Your artistic interpretation has been respectfully declined.");
    }
    document.querySelector("#service-status").textContent = "Model online";
  } catch {
    showResult("error", "!", "The model couldn’t be reached", "Your drawing is still here. The service may be starting or temporarily unavailable. Please try again in a moment.");
    document.querySelector("#service-status").textContent = "Connection interrupted";
  } finally {
    clearTimeout(timeout); clearTimeout(waking); busy = false;
    predictButton.disabled = false; clearButton.disabled = false; exampleButtons.forEach(button => { button.disabled = false; });
    predictButton.replaceChildren(document.createTextNode("Predict "));
    const arrow = document.createElement("span"); arrow.setAttribute("aria-hidden", "true"); arrow.textContent = "→"; predictButton.append(arrow);
  }
});

resetDrawing();
fetch("evaluation.json").then(response => response.ok ? response.json() : Promise.reject()).then(data => {
  if (!Number.isFinite(data.digit_accuracy_before_rejection) || !Number.isFinite(data.negative_rejection_rate)) return;
  document.querySelector("#metric-summary").textContent = `${(data.digit_accuracy_before_rejection * 100).toFixed(1)}% MNIST digit accuracy`;
  document.querySelector("#metric-detail").textContent = `Before rejection, on ${data.mnist_test_count.toLocaleString()} preprocessed test digits. ${(data.digit_acceptance_rate * 100).toFixed(1)}% of test digits accepted; ${(data.negative_rejection_rate * 100).toFixed(1)}% of ${data.negative_test_count.toLocaleString()} tested non-digit examples rejected. These scores do not cover every possible drawing.`;
}).catch(() => {});
