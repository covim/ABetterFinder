import React from "react";
import ReactDOM from "react-dom/client";
import App from "@/App";
import "@/index.css";
import { loadTheme } from "@/lib/settings";
import { applyTheme } from "@/lib/theme";

// Vor dem ersten Rendern, damit das gespeicherte Schema nicht erst nachflackert.
applyTheme(loadTheme());

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
