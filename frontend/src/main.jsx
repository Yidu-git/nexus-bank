import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import "./styles.css";
import "./landing.css";
import { applyTheme, getTheme } from "./theme.js";

applyTheme(getTheme()); // set before first paint so there is no flash

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
