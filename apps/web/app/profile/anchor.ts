// The /profile sections render after the session check and their own loads, so the browser's jump to
// /profile#body or /profile#allergens finds nothing on a full page load (and a section loading above the
// target pushes it down). Each section calls this once its form has rendered.

const ANCHORS = new Set(["body", "allergens"]);

/** Scrolls to the section the URL's hash names, if it is one of the settings sections. */
export function scrollToProfileAnchor(): void {
  const id = window.location.hash.slice(1);
  if (ANCHORS.has(id)) document.getElementById(id)?.scrollIntoView();
}
