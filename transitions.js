/* ============================================================
   BOX:ON — page transition
   Four symbol blades converge from corners one-by-one,
   then disperse outward on the new page.
   ============================================================ */

(() => {
  "use strict";

  // build shutter DOM if missing
  function ensureShutter() {
    let shutter = document.querySelector(".page-shutter");
    if (shutter) return shutter;
    shutter = document.createElement("div");
    shutter.className = "page-shutter";
    shutter.innerHTML =
      '<div class="page-shutter__bg"></div>' +
      '<div class="page-shutter__symbol">' +
        '<span class="page-shutter__blade page-shutter__blade--tl"></span>' +
        '<span class="page-shutter__blade page-shutter__blade--tr"></span>' +
        '<span class="page-shutter__blade page-shutter__blade--bl"></span>' +
        '<span class="page-shutter__blade page-shutter__blade--br"></span>' +
      '</div>' +
      '<div class="page-shutter__label">BOX:ON</div>';
    document.body.appendChild(shutter);
    return shutter;
  }

  const shutter = ensureShutter();

  function clearStates() {
    shutter.classList.remove(
      "is-converging",
      "is-dispersing",
      "is-locked"
    );
  }

  // ENTRY — page just loaded. No animation; page appears immediately.
  function playEntry() {
    clearStates();
  }

  // EXIT — link clicked. Blades converge one by one, then navigate.
  function playExitThenGo(href) {
    clearStates();
    shutter.classList.add("is-converging");
    // total convergence time: stagger 3*100ms + transition 600ms ≈ 900ms
    setTimeout(() => { window.location.href = href; }, 880);
  }

  function isInternalNavLink(a) {
    const href = a.getAttribute("href");
    if (!href) return false;
    if (a.target === "_blank") return false;
    if (href.startsWith("#")) return false;
    if (href.startsWith("mailto:") || href.startsWith("tel:")) return false;
    return /\.html(\b|#|$)/i.test(href);
  }

  function bindLinks() {
    document.querySelectorAll("a[href]").forEach((a) => {
      if (a.__ptBound) return;
      a.__ptBound = true;
      a.addEventListener("click", (e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        if (!isInternalNavLink(a)) return;
        const href = a.getAttribute("href");
        const here = window.location.pathname.split("/").pop() || "index.html";
        if (href.startsWith(here + "#")) return; // same-page anchor
        e.preventDefault();
        playExitThenGo(href);
      });
    });
  }

  window.addEventListener("pageshow", (e) => {
    if (e.persisted) playEntry();
  });

  // Reveal-on-scroll for the ABOUT poster strip. Click → smooth scroll
  // (CSS scroll-behavior) → IntersectionObserver fires → slide-up animation.
  function initStripReveal() {
    const strip = document.querySelector(".strip");
    if (!strip) return;
    const reveal = () => strip.classList.add("is-revealed");
    if (!("IntersectionObserver" in window)) { reveal(); return; }
    const io = new IntersectionObserver((entries) => {
      entries.forEach((e) => {
        if (e.isIntersecting) { reveal(); io.disconnect(); }
      });
    }, { threshold: 0.22 });
    io.observe(strip);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => { bindLinks(); playEntry(); initStripReveal(); });
  } else {
    bindLinks();
    playEntry();
    initStripReveal();
  }
})();
