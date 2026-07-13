export function scrollToBlock(id: string) {
  const el = document.querySelector(`[data-block-id="${id}"]`);
  if (el) {
    el.scrollIntoView({ behavior: "smooth", block: "center" });
  }
}
