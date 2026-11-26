// The /profile sections render after the session check and their own loads, so the browser's jump to
// /profile#body or /profile#allergens finds nothing on a full page load. The section the hash names
// scrolls itself into view once, when its form first renders (a section loading above it later is
// covered by the browser's scroll anchoring); a retry or a later reload of the section does not jump.

export type ProfileAnchor = "body" | "allergens";

/** Scrolls to `id` if the URL's hash names it. */
export function scrollToProfileAnchor(id: ProfileAnchor): void {
  if (window.location.hash === `#${id}`) document.getElementById(id)?.scrollIntoView();
}
