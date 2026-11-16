import { el } from "/api.js";
import { button } from "/settings-controls.js";

// Shared by chat and coding policies; keyboard buttons also work on touchscreens.
export function orderedModels(values, render, changed, { addValue = () => "", removable = true } = {}) {
  const host = el("div", "model-order");
  let dragging;
  function move(from, to) {
    if (!Number.isInteger(from) || from < 0 || to < 0 || to >= values.length || from === to) return;
    values.splice(to, 0, values.splice(from, 1)[0]); changed(); draw();
    host.querySelectorAll(".model-drag")[to]?.focus();
  }
  function draw() {
    host.replaceChildren();
    values.forEach((value, index) => {
      const row = el("div", "model-order-row"); row.dataset.index = index;
      const handle = button("⠿", () => {}); handle.classList.add("model-drag"); handle.draggable = true;
      handle.setAttribute("aria-label", `Reorder model ${index + 1}`); handle.title = "Drag to reorder, or use Alt + arrow keys";
      handle.ondragstart = event => { dragging = index; event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", String(index)); };
      handle.ondragend = () => { dragging = undefined; row.classList.remove("drag-over"); };
      handle.onkeydown = event => { if (event.altKey && ["ArrowUp", "ArrowDown"].includes(event.key)) { event.preventDefault(); move(index, index + (event.key === "ArrowUp" ? -1 : 1)); } };
      row.ondragover = event => { if (dragging !== undefined) { event.preventDefault(); row.classList.add("drag-over"); } };
      row.ondragleave = () => row.classList.remove("drag-over");
      row.ondrop = event => { event.preventDefault(); move(dragging, index); dragging = undefined; };
      const controls = el("div", "model-order-fields"); render(controls, value, index);
      const up = button("↑", () => move(index, index - 1)), down = button("↓", () => move(index, index + 1));
      up.setAttribute("aria-label", `Move model ${index + 1} up`); down.setAttribute("aria-label", `Move model ${index + 1} down`);
      up.disabled = index === 0; down.disabled = index === values.length - 1;
      row.append(handle, el("span", "model-position", String(index + 1)), controls, up, down);
      if (removable) row.append(button("Remove", () => { values.splice(index, 1); changed(); draw(); }));
      host.append(row);
    });
    host.append(button("Add model", () => { values.push(addValue()); changed(); draw(); }));
  }
  draw(); return host;
}
