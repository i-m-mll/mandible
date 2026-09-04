/**
 * Persistent IAB preview branches are long-lived review workspaces, not
 * delivery branches.  Protected delivery must use a disposable branch pinned
 * to the exact reviewed preview HEAD so accepting it cannot destroy the
 * workspace the user is still reviewing.
 */
export function isPersistentIabPreviewBranch(branch: string | null | undefined): boolean {
  return /^integration\/mandible-iab-preview-/.test(branch?.trim() ?? "");
}

export const PERSISTENT_IAB_PREVIEW_DELIVERY_ERROR =
  "Persistent IAB preview branches cannot be submitted for protected merge; create a disposable delivery branch at the exact reviewed preview HEAD.";
