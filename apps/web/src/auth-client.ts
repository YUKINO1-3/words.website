let csrfToken = "";
export function setCsrfToken(value: string) {
  csrfToken = value;
}
export function getCsrfToken() {
  return csrfToken;
}
export function sessionExpired() {
  csrfToken = "";
  window.dispatchEvent(new Event("vocabflow-session-expired"));
}
