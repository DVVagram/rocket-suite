const json = (r) => {
  if (!r.ok) {
    return r.json().then(
      (body) => { throw new Error(body.detail || r.statusText); },
      () => { throw new Error(r.statusText); }
    );
  }
  return r.json();
};

export const api = {
  health: () => fetch("/api/health").then(json),
  examples: () => fetch("/api/examples").then(json),
  openDesign: (path) =>
    fetch("/api/design/open", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path }),
    }).then(json),
  simulate: (payload) =>
    fetch("/api/simulate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).then(json),
  projects: () => fetch("/api/projects").then(json),
};
