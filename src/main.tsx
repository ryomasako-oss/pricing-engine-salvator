import React from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider, createBrowserRouter } from "react-router-dom";
import { App } from "./App";
import { AuthProvider } from "./context/AuthContext";
import { ThemeProvider } from "./context/ThemeContext";
import { ToastProvider } from "./context/ToastContext";
import { UnsavedGuardProvider } from "./context/UnsavedGuardContext";
import "./styles.css";

// A tab opened before a deploy still asks for the old chunk names (ocr-…js),
// which the new build no longer has: reload onto the new build. At most once
// per 30 s, so a chunk that is really missing can't loop. Unsaved quote edits
// still get the beforeunload prompt (UnsavedGuardContext).
window.addEventListener("vite:preloadError", (event) => {
  try {
    const last = Number(sessionStorage.getItem("chunk-reload-at") ?? 0);
    if (Date.now() - last < 30_000) return;
    sessionStorage.setItem("chunk-reload-at", String(Date.now()));
  } catch {
    return;
  }
  event.preventDefault();
  window.location.reload();
});

// A data router (not BrowserRouter) so the unsaved-edits guard can use useBlocker;
// the app keeps its own <Routes> under this one catch-all route.
const router = createBrowserRouter([
  {
    path: "*",
    element: (
      <ToastProvider>
        <AuthProvider>
          <UnsavedGuardProvider>
            <App />
          </UnsavedGuardProvider>
        </AuthProvider>
      </ToastProvider>
    ),
  },
]);

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ThemeProvider>
      <RouterProvider router={router} />
    </ThemeProvider>
  </React.StrictMode>,
);
