document.documentElement.classList.add("has-js");

for (const hash of document.querySelectorAll(".checksums code")) {
  const button = document.createElement("button");
  const status = document.createElement("span");
  let restoreTimer;

  button.className = "copy-hash";
  button.type = "button";
  button.textContent = "复制";

  status.className = "copy-status";
  status.setAttribute("aria-live", "polite");

  hash.insertAdjacentElement("afterend", button);
  button.insertAdjacentElement("afterend", status);

  button.addEventListener("click", async () => {
    window.clearTimeout(restoreTimer);
    status.textContent = "";

    try {
      if (!navigator.clipboard?.writeText) {
        throw new Error("Clipboard API unavailable");
      }
      await navigator.clipboard.writeText(hash.textContent.trim());
      button.textContent = "已复制";
      restoreTimer = window.setTimeout(() => {
        button.textContent = "复制";
      }, 1600);
    } catch {
      button.textContent = "复制";
      status.textContent = "复制失败，请手动复制";
    }
  });
}
