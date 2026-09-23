import { markerOverlay, proofBars, PROOF_ROW_HEIGHT, PROOF_SCALE } from "../src/spike-layout.js";

function element(root: ParentNode, selector: string): HTMLElement {
  const node = root.querySelector(selector);
  if (!(node instanceof HTMLElement)) {
    throw new Error(`missing ${selector}`);
  }
  return node;
}

export function readProof(root: ParentNode): void {
  const envelope = element(root, "[data-spike-key='env-1']");
  const target = element(root, "[data-spike-key='tgt-budget']");
  if (root.querySelector("[data-spike-key='tgt-cpa']") !== null) {
    throw new Error("collapsed CPA target lane is visible");
  }
  if (target.getBoundingClientRect().top <= envelope.getBoundingClientRect().top) {
    throw new Error("target lane is not below its envelope");
  }
  if (root.querySelector(".wx-marker") !== null) {
    throw new Error("SVAR PRO marker was rendered");
  }
  const expected = markerOverlay(proofBars(), PROOF_SCALE, PROOF_ROW_HEIGHT);
  const approval = expected.find((marker) => marker.id === "m-approval");
  const comment = expected.find((marker) => marker.id === "m-comment");
  if (approval === undefined || comment === undefined || comment.x - approval.x >= 6) {
    throw new Error("close markers were not within 6px");
  }
  for (const marker of expected) {
    const node = element(root, `[data-marker-id='${marker.id}']`);
    const left = Number.parseFloat(node.style.left);
    if (!Number.isFinite(left) || Math.abs(left - marker.x) > 0.01) {
      throw new Error(`marker ${marker.id} is not on the scale`);
    }
    if (node.getAttribute("data-cluster-id") !== marker.clusterId) {
      throw new Error(`marker ${marker.id} cluster mismatch`);
    }
  }
}

export function appendMarkerOverlay(parent: HTMLElement): void {
  const overlay = document.createElement("div");
  overlay.setAttribute("data-marker-overlay", "");
  overlay.style.position = "absolute";
  overlay.style.left = "0";
  overlay.style.top = "0";
  overlay.style.width = `${PROOF_SCALE.widthPx}px`;
  overlay.style.height = "120px";
  overlay.style.pointerEvents = "none";
  overlay.style.zIndex = "5";
  for (const marker of markerOverlay(proofBars(), PROOF_SCALE, PROOF_ROW_HEIGHT)) {
    const node = document.createElement("div");
    node.dataset["markerId"] = marker.id;
    node.dataset["clusterId"] = marker.clusterId;
    node.style.position = "absolute";
    node.style.left = `${marker.x}px`;
    node.style.top = `${marker.y}px`;
    node.style.width = "8px";
    node.style.height = "8px";
    overlay.appendChild(node);
  }
  parent.appendChild(overlay);
}
