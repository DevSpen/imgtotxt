const fileInput = document.getElementById("fileInput");
const dropZone = document.getElementById("dropZone");
const languageMultiSelect = document.getElementById("languageMultiSelect");
const languageDropdownBtn = document.getElementById("languageDropdownBtn");
const languageDropdownMenu = document.getElementById("languageDropdownMenu");
const psmSelect = document.getElementById("psmSelect");
const readingOrderSelect = document.getElementById("readingOrderSelect");
const cleanupTextToggle = document.getElementById("cleanupTextToggle");
const pdfNativeTextToggle = document.getElementById("pdfNativeTextToggle");

const startCameraBtn = document.getElementById("startCameraBtn");
const captureBtn = document.getElementById("captureBtn");
const stopCameraBtn = document.getElementById("stopCameraBtn");
const transcribeBtn = document.getElementById("transcribeBtn");
const transcribeAllBtn = document.getElementById("transcribeAllBtn");
const copyBtn = document.getElementById("copyBtn");
const copyAllBtn = document.getElementById("copyAllBtn");
const downloadBtn = document.getElementById("downloadBtn");
const downloadAllBtn = document.getElementById("downloadAllBtn");
const clearBtn = document.getElementById("clearBtn");
const removeImageBtn = document.getElementById("removeImageBtn");
const prevImageBtn = document.getElementById("prevImageBtn");
const nextImageBtn = document.getElementById("nextImageBtn");
const imageCounter = document.getElementById("imageCounter");

const imagePreview = document.getElementById("imagePreview");
const cameraFeed = document.getElementById("cameraFeed");
const captureCanvas = document.getElementById("captureCanvas");
const previewPlaceholder = document.getElementById("previewPlaceholder");
const previewPanel = document.querySelector(".preview-panel");

const statusText = document.getElementById("statusText");
const confidenceText = document.getElementById("confidenceText");
const progressBar = document.getElementById("progressBar");
const resultText = document.getElementById("resultText");
const resultPanel = document.querySelector(".result-panel");

let activeStream = null;
let isCameraPreviewActive = false;
let isTranscribing = false;
let currentImageIndex = -1;
let imageIdSeed = 1;
const images = [];
const languageCheckboxes = Array.from(
  document.querySelectorAll("#languageDropdownMenu input[type='checkbox']")
);
const PDF_WORKER_SRC = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
let persistentOcrWorker = null;
let persistentOcrWorkerLanguage = "";
let persistentOcrWorkerInitPromise = null;
let ocrProgressLogger = null;

function setStatus(text) {
  statusText.textContent = text;
}

function setProgress(value) {
  if (!Number.isFinite(value)) {
    progressBar.style.width = "0%";
    return;
  }

  // Accept both 0..1 and 0..100 progress scales.
  const scaled = value > 1 && value <= 100 ? value / 100 : value;
  const normalized = Math.max(0, Math.min(1, scaled));
  progressBar.style.width = `${Math.round(normalized * 100)}%`;
}

function clampProgress(value) {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, value));
}

function setConfidence(value) {
  confidenceText.textContent = Number.isFinite(value)
    ? `Confidence: ${value.toFixed(1)}%`
    : "Confidence: --";
}

function setResultActionsEnabled(enabled) {
  copyBtn.disabled = !enabled;
  downloadBtn.disabled = !enabled;
}

function hasAnyTranscribedText() {
  return images.some((image) => image.hasOcr && formatDisplayText(image.rawOcrText || "").trim());
}

function updateBulkActionsState() {
  const hasMultiple = images.length > 1;
  copyAllBtn.hidden = !hasMultiple;
  downloadAllBtn.hidden = !hasMultiple;

  const enabled = hasMultiple && hasAnyTranscribedText();
  copyAllBtn.disabled = !enabled;
  downloadAllBtn.disabled = !enabled;
}

function getCombinedTranscriptionText() {
  const parts = [];

  for (let i = 0; i < images.length; i += 1) {
    const image = images[i];
    if (!image.hasOcr) {
      continue;
    }

    const body = formatDisplayText(image.rawOcrText || image.ocrText || "").trim();
    if (!body) {
      continue;
    }

    const sectionLabel = image.sourceLabel || `Image ${i + 1}`;
    parts.push(`--- ${sectionLabel} ---\n${body}`);
  }

  return parts.join("\n\n");
}

function cleanExtractedText(text) {
  let output = (text || "").replace(/\r\n?/g, "\n");

  // Join words split by line-wrap hyphenation, e.g. "Chris-\ntian" -> "Christian".
  output = output.replace(/([A-Za-z])(?:-|\u00AD)\s*\n\s*([A-Za-z])/g, "$1$2");

  // Normalize paragraph separators to a single blank line.
  output = output.replace(/\n[ \t]*\n+/g, "\n\n");

  // Remaining single newlines are treated as line wraps within a paragraph.
  output = output.replace(/([^\n])\n(?!\n)/g, "$1 ");

  // Collapse extra spacing introduced by OCR line wraps.
  output = output.replace(/[ \t]{2,}/g, " ").replace(/[ \t]+\n/g, "\n");

  return output.trim();
}

function formatDisplayText(rawText) {
  const trimmed = (rawText || "").trim();
  if (!trimmed) {
    return "";
  }

  if (!cleanupTextToggle?.checked) {
    return trimmed;
  }

  return cleanExtractedText(trimmed);
}

function getCurrentImage() {
  if (currentImageIndex < 0 || currentImageIndex >= images.length) {
    return null;
  }

  return images[currentImageIndex];
}

function isImageFile(file) {
  const type = (file.type || "").toLowerCase();
  if (type.startsWith("image/")) {
    return true;
  }

  const name = (file.name || "").toLowerCase();
  return /\.(png|jpe?g|webp|gif|bmp|tiff?|heic|heif|avif)$/i.test(name);
}

function isPdfFile(file) {
  const type = (file.type || "").toLowerCase();
  const name = (file.name || "").toLowerCase();
  return type === "application/pdf" || name.endsWith(".pdf");
}

async function isLikelyPdfFile(file) {
  if (isPdfFile(file)) {
    return true;
  }

  try {
    const headerBuffer = await file.slice(0, 5).arrayBuffer();
    const headerBytes = new Uint8Array(headerBuffer);
    const headerText = String.fromCharCode(...headerBytes);
    return headerText === "%PDF-";
  } catch {
    return false;
  }
}

function ensurePdfWorkerConfigured() {
  if (!window.pdfjsLib) {
    throw new Error("PDF engine unavailable");
  }

  if (window.pdfjsLib.GlobalWorkerOptions.workerSrc !== PDF_WORKER_SRC) {
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDF_WORKER_SRC;
  }
}

async function extractNativePdfTextFromPage(page) {
  const textContent = await page.getTextContent({
    normalizeWhitespace: true,
    disableCombineTextItems: false
  });

  const items = textContent?.items || [];
  if (!items.length) {
    return "";
  }

  const lines = [];
  let currentLine = [];
  let lastY = null;
  const newLineThreshold = 4;

  for (const item of items) {
    const str = (item.str || "").trim();
    const y = typeof item.transform?.[5] === "number" ? item.transform[5] : lastY;

    if (lastY !== null && y !== null && Math.abs(y - lastY) > newLineThreshold && currentLine.length) {
      lines.push(currentLine.join(" ").replace(/\s+([,.;:!?])/g, "$1").trim());
      currentLine = [];
    }

    if (str) {
      currentLine.push(str);
    }

    if (item.hasEOL && currentLine.length) {
      lines.push(currentLine.join(" ").replace(/\s+([,.;:!?])/g, "$1").trim());
      currentLine = [];
    }

    if (y !== null) {
      lastY = y;
    }
  }

  if (currentLine.length) {
    lines.push(currentLine.join(" ").replace(/\s+([,.;:!?])/g, "$1").trim());
  }

  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

async function renderPdfFileToDataUrls(file) {
  ensurePdfWorkerConfigured();

  const buffer = await file.arrayBuffer();
  const loadingTask = window.pdfjsLib.getDocument({ data: buffer });
  const pdf = await loadingTask.promise;

  const output = [];
  const fileLabel = file.name || "PDF";

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    setStatus(`Preparing ${fileLabel}: page ${pageNumber}/${pdf.numPages}...`);

    const page = await pdf.getPage(pageNumber);
    const nativeText = await extractNativePdfTextFromPage(page);
    const baseViewport = page.getViewport({ scale: 1 });
    const targetMaxSide = 2200;
    const maxSide = Math.max(baseViewport.width, baseViewport.height);
    const scaled = targetMaxSide / maxSide;
    const scale = Math.max(1.3, Math.min(2.2, scaled));
    const viewport = page.getViewport({ scale });

    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.floor(viewport.width));
    canvas.height = Math.max(1, Math.floor(viewport.height));

    const ctx = canvas.getContext("2d", { alpha: false, willReadFrequently: true });
    await page.render({ canvasContext: ctx, viewport }).promise;

    output.push({
      dataUrl: canvas.toDataURL("image/png"),
      sourceLabel: `${fileLabel} - page ${pageNumber}`,
      nativeText
    });
  }

  return output;
}

function getSelectedLanguageCode() {
  const selected = languageCheckboxes
    .filter((checkbox) => checkbox.checked)
    .map((checkbox) => checkbox.value)
    .filter(Boolean);

  return selected.length ? selected.join("+") : "eng";
}

function getOcrSettingsSignature() {
  return `${getSelectedLanguageCode()}|${Number(psmSelect.value)}|${readingOrderSelect.value}`;
}

function getTargetSettingsKeyForRecord(record) {
  const nativePdfText = (record.pdfNativeText || "").trim();
  if (pdfNativeTextToggle?.checked && nativePdfText) {
    return "native-text";
  }

  return `ocr:${getOcrSettingsSignature()}`;
}

async function createPersistentWorker(language) {
  if (!window.Tesseract?.createWorker) {
    return null;
  }

  const loggerProxy = (info) => {
    if (typeof ocrProgressLogger === "function") {
      ocrProgressLogger(info);
    }
  };

  // Prefer modern v5 API.
  try {
    return await window.Tesseract.createWorker(language || "eng", 1, { logger: loggerProxy });
  } catch {
    // Legacy API fallback (older Tesseract.js signatures).
    const worker = await window.Tesseract.createWorker({ logger: loggerProxy });
    if (typeof worker.load === "function") {
      await worker.load();
    }
    if (typeof worker.loadLanguage === "function") {
      await worker.loadLanguage(language || "eng");
    }
    if (typeof worker.initialize === "function") {
      await worker.initialize(language || "eng");
    }
    return worker;
  }
}

async function ensurePersistentWorker(language) {
  const targetLanguage = language || "eng";

  if (!persistentOcrWorker) {
    if (!persistentOcrWorkerInitPromise) {
      persistentOcrWorkerInitPromise = (async () => {
        persistentOcrWorker = await createPersistentWorker(targetLanguage);
        persistentOcrWorkerLanguage = targetLanguage;
      })();
    }

    try {
      await persistentOcrWorkerInitPromise;
    } finally {
      persistentOcrWorkerInitPromise = null;
    }
    return persistentOcrWorker;
  }

  if (persistentOcrWorkerLanguage === targetLanguage) {
    return persistentOcrWorker;
  }

  try {
    if (typeof persistentOcrWorker.reinitialize === "function") {
      await persistentOcrWorker.reinitialize(targetLanguage);
      persistentOcrWorkerLanguage = targetLanguage;
      return persistentOcrWorker;
    }

    if (
      typeof persistentOcrWorker.loadLanguage === "function" &&
      typeof persistentOcrWorker.initialize === "function"
    ) {
      await persistentOcrWorker.loadLanguage(targetLanguage);
      await persistentOcrWorker.initialize(targetLanguage);
      persistentOcrWorkerLanguage = targetLanguage;
      return persistentOcrWorker;
    }
  } catch {
    // fall through and recreate worker
  }

  try {
    if (typeof persistentOcrWorker.terminate === "function") {
      await persistentOcrWorker.terminate();
    }
  } catch {
    // no-op
  }

  persistentOcrWorker = await createPersistentWorker(targetLanguage);
  persistentOcrWorkerLanguage = targetLanguage;
  return persistentOcrWorker;
}

function closeLanguageDropdown() {
  languageDropdownMenu.hidden = true;
  languageDropdownBtn.setAttribute("aria-expanded", "false");
}

function openLanguageDropdown() {
  languageDropdownMenu.hidden = false;
  languageDropdownBtn.setAttribute("aria-expanded", "true");
}

function updateLanguageDropdownLabel() {
  const selectedLabels = languageCheckboxes
    .filter((checkbox) => checkbox.checked)
    .map((checkbox) => checkbox.parentElement?.textContent?.trim())
    .filter(Boolean);

  if (!selectedLabels.length) {
    languageDropdownBtn.textContent = "English";
    return;
  }

  if (selectedLabels.length === 1) {
    languageDropdownBtn.textContent = selectedLabels[0];
    return;
  }

  languageDropdownBtn.textContent = `${selectedLabels[0]} +${selectedLabels.length - 1}`;
}

function updateTranscribeState() {
  const hasCurrent = Boolean(getCurrentImage());
  const hasAnyImages = images.length > 0;
  transcribeBtn.disabled = isTranscribing || !hasCurrent;
  transcribeAllBtn.disabled = isTranscribing || !hasAnyImages;
}

function updatePreviewControls() {
  const hasImages = images.length > 0;
  const hasMultiple = images.length > 1;

  if (isCameraPreviewActive && activeStream) {
    prevImageBtn.hidden = true;
    nextImageBtn.hidden = true;
    removeImageBtn.hidden = true;
    removeImageBtn.disabled = true;

    if (hasImages) {
      imageCounter.hidden = false;
      imageCounter.textContent = `Live camera | ${images.length} saved`;
    } else {
      imageCounter.hidden = true;
      imageCounter.textContent = "";
    }
    return;
  }

  imageCounter.hidden = !hasImages;
  imageCounter.textContent = hasImages ? `${currentImageIndex + 1} / ${images.length}` : "";

  prevImageBtn.hidden = !hasMultiple;
  nextImageBtn.hidden = !hasMultiple;
  removeImageBtn.hidden = !hasImages;
  removeImageBtn.disabled = isTranscribing || !hasImages;
}

function syncResultFromCurrentImage() {
  const current = getCurrentImage();

  if (!current || !current.hasOcr) {
    resultText.value = "";
    setConfidence(NaN);
    setResultActionsEnabled(false);
    if (!isTranscribing) {
      setProgress(0);
    }
    updateBulkActionsState();
    return;
  }

  const sourceText = current.rawOcrText || current.ocrText;
  const displayText = formatDisplayText(sourceText);
  current.ocrText = displayText;
  resultText.value = displayText;
  setConfidence(current.confidence);
  setResultActionsEnabled(Boolean(displayText.trim()));
  if (!isTranscribing) {
    setProgress(1);
  }
  updateBulkActionsState();
}

function refreshPreview() {
  const current = getCurrentImage();
  const hasSourceImage = images.length > 0;

  if (resultPanel) {
    resultPanel.classList.toggle("has-source-image", hasSourceImage);
  }

  if (isCameraPreviewActive && activeStream) {
    cameraFeed.hidden = false;
    imagePreview.hidden = true;
    previewPlaceholder.hidden = true;
  } else if (current) {
    imagePreview.src = current.dataUrl;
    imagePreview.hidden = false;
    cameraFeed.hidden = true;
    previewPlaceholder.hidden = true;
  } else {
    imagePreview.hidden = true;
    cameraFeed.hidden = true;
    previewPlaceholder.hidden = false;
  }

  updatePreviewControls();
  updateTranscribeState();
  updateBulkActionsState();
  updateDefaultTextareaHeight();
}

function updateDefaultTextareaHeight() {
  if (!resultPanel || !previewPanel) {
    return;
  }

  if (images.length === 0) {
    resultPanel.style.removeProperty("--auto-textarea-height");
    return;
  }

  const previewHeight = previewPanel.offsetHeight;
  const nonTextareaHeight = resultPanel.offsetHeight - resultText.offsetHeight;
  const target = Math.max(220, previewHeight - nonTextareaHeight);
  resultPanel.style.setProperty("--auto-textarea-height", `${Math.floor(target)}px`);
}

function setCurrentImageByIndex(index) {
  if (!images.length) {
    currentImageIndex = -1;
    syncResultFromCurrentImage();
    refreshPreview();
    return;
  }

  const clamped = Math.max(0, Math.min(index, images.length - 1));
  currentImageIndex = clamped;
  syncResultFromCurrentImage();
  refreshPreview();
}

function createImageRecord(dataUrl, sourceLabel = "", pdfNativeText = "") {
  return {
    id: imageIdSeed,
    dataUrl,
    sourceLabel,
    pdfNativeText,
    rawOcrText: "",
    ocrText: "",
    confidence: NaN,
    hasOcr: false,
    regionCount: 0,
    ocrSettingsKey: ""
  };
}

function loadImageElement(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Image load failed"));
    img.src = src;
  });
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("Failed to read image file"));
    reader.readAsDataURL(file);
  });
}

function toCanvasDataUrlFromRegion(img, region) {
  const canvas = document.createElement("canvas");
  canvas.width = region.width;
  canvas.height = region.height;

  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(
    img,
    region.x,
    region.y,
    region.width,
    region.height,
    0,
    0,
    region.width,
    region.height
  );

  return canvas.toDataURL("image/png");
}

function detectColumnSplitX(img) {
  const sampleWidth = Math.min(1600, img.naturalWidth || img.width);
  const sampleHeight = Math.min(2200, img.naturalHeight || img.height);

  const canvas = document.createElement("canvas");
  canvas.width = sampleWidth;
  canvas.height = sampleHeight;

  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, sampleWidth, sampleHeight);
  const pixels = ctx.getImageData(0, 0, sampleWidth, sampleHeight).data;

  const darknessByX = new Float64Array(sampleWidth);
  for (let y = 0; y < sampleHeight; y += 1) {
    const rowOffset = y * sampleWidth * 4;
    for (let x = 0; x < sampleWidth; x += 1) {
      const i = rowOffset + x * 4;
      const r = pixels[i];
      const g = pixels[i + 1];
      const b = pixels[i + 2];
      const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      const darkness = 255 - luminance;
      if (darkness > 45) {
        darknessByX[x] += darkness;
      }
    }
  }

  const centerStart = Math.floor(sampleWidth * 0.28);
  const centerEnd = Math.floor(sampleWidth * 0.72);
  let bestX = -1;
  let bestValue = Number.POSITIVE_INFINITY;
  let total = 0;
  let count = 0;

  for (let x = centerStart; x <= centerEnd; x += 1) {
    const v = darknessByX[x];
    total += v;
    count += 1;
    if (v < bestValue) {
      bestValue = v;
      bestX = x;
    }
  }

  if (count === 0 || bestX < 0) {
    return null;
  }

  const avg = total / count;
  if (bestValue > avg * 0.72) {
    return null;
  }

  return Math.round((bestX / sampleWidth) * img.width);
}

function buildRegionsForReadingMode(img, mode) {
  const imgWidth = img.width;
  const imgHeight = img.height;

  if (mode === "single") {
    return [{ x: 0, y: 0, width: imgWidth, height: imgHeight, label: "full page" }];
  }

  const detectedSplitX = detectColumnSplitX(img);
  const splitX = detectedSplitX || Math.floor(imgWidth / 2);

  if (mode === "auto" && !detectedSplitX) {
    return [{ x: 0, y: 0, width: imgWidth, height: imgHeight, label: "full page" }];
  }

  const gutter = Math.max(8, Math.floor(imgWidth * 0.012));
  const leftWidth = Math.max(20, splitX - gutter);
  const rightX = Math.min(imgWidth - 20, splitX + gutter);
  const rightWidth = Math.max(20, imgWidth - rightX);

  return [
    { x: 0, y: 0, width: leftWidth, height: imgHeight, label: "left column" },
    { x: rightX, y: 0, width: rightWidth, height: imgHeight, label: "right column" }
  ];
}

async function recognizeRegion(
  source,
  language,
  psm,
  regionLabel,
  progressStart,
  progressEnd,
  progressFn = setProgress
) {
  const span = progressEnd - progressStart;
  let sawLoggerProgress = false;
  let heartbeatProgress = progressStart;
  let heartbeatTick = 0;
  const heartbeatCeil = Math.max(progressStart, progressEnd - 0.02);

  setStatus(`OCR ${regionLabel}: processing...`);
  progressFn(progressStart);

  const heartbeat = setInterval(() => {
    if (sawLoggerProgress) {
      return;
    }

    heartbeatTick += 1;
    const step = heartbeatTick < 12 ? 0.006 : 0.003;
    heartbeatProgress = Math.min(heartbeatCeil, heartbeatProgress + step);
    progressFn(heartbeatProgress);
  }, 220);

  const logger = (info) => {
    if (typeof info.progress === "number") {
      sawLoggerProgress = true;
      progressFn(progressStart + span * info.progress);
    }

    if (info.status) {
      setStatus(`OCR ${regionLabel}: ${info.status}`);
    }
  };

  ocrProgressLogger = logger;

  try {
    const worker = await ensurePersistentWorker(language);
    if (!worker) {
      throw new Error("Persistent worker unavailable");
    }

    if (typeof worker.setParameters === "function") {
      await worker.setParameters({ tessedit_pageseg_mode: psm });
    }

    return worker.recognize(source);
  } catch {
    return Tesseract.recognize(source, language, {
      logger,
      tessedit_pageseg_mode: psm
    });
  } finally {
    clearInterval(heartbeat);
    progressFn(Math.max(progressStart, Math.min(progressEnd, 1)));
    ocrProgressLogger = null;
  }
}

async function transcribeWithLayoutMode(dataUrl, language, psm, readingMode, progressFn = setProgress) {
  const image = await loadImageElement(dataUrl);
  const regions = buildRegionsForReadingMode(image, readingMode);

  if (regions.length === 1) {
    const result = await recognizeRegion(dataUrl, language, psm, "full page", 0, 1, progressFn);
    return {
      text: result?.data?.text?.trim() || "",
      confidence: result?.data?.confidence,
      regionCount: 1
    };
  }

  let mergedText = "";
  let confidenceSum = 0;
  let confidenceCount = 0;

  for (let i = 0; i < regions.length; i += 1) {
    const region = regions[i];
    const regionDataUrl = toCanvasDataUrlFromRegion(image, region);
    const start = i / regions.length;
    const end = (i + 1) / regions.length;

    const partial = await recognizeRegion(
      regionDataUrl,
      language,
      psm,
      region.label,
      start,
      end,
      progressFn
    );
    const text = partial?.data?.text?.trim() || "";

    if (text) {
      mergedText += mergedText ? `\n\n${text}` : text;
    }

    const words = partial?.data?.words || [];
    if (words.length) {
      confidenceSum += words.reduce((sum, word) => sum + (word.confidence || 0), 0);
      confidenceCount += words.length;
    } else if (typeof partial?.data?.confidence === "number") {
      confidenceSum += partial.data.confidence;
      confidenceCount += 1;
    }
  }

  return {
    text: mergedText,
    confidence: confidenceCount ? confidenceSum / confidenceCount : NaN,
    regionCount: regions.length
  };
}

async function addFiles(fileList) {
  const files = Array.from(fileList || []);

  if (!files.length) {
    setStatus("Please provide at least one valid image/PDF file.");
    return;
  }

  let addedItems = 0;
  let skippedFiles = 0;
  let failedFiles = 0;
  const messages = [];

  for (const file of files) {
    if (isImageFile(file)) {
      try {
        const dataUrl = await readFileAsDataUrl(file);
        images.push(createImageRecord(dataUrl, file.name || `Image ${images.length + 1}`));
        imageIdSeed += 1;
        addedItems += 1;
      } catch {
        failedFiles += 1;
      }
      continue;
    }

    const looksLikePdf = await isLikelyPdfFile(file);
    if (looksLikePdf) {
      try {
        const pages = await renderPdfFileToDataUrls(file);
        for (const page of pages) {
          images.push(createImageRecord(page.dataUrl, page.sourceLabel, page.nativeText));
          imageIdSeed += 1;
          addedItems += 1;
        }
        messages.push(`${file.name || "PDF"} (${pages.length} pages)`);
      } catch (error) {
        console.error("PDF load failed:", file?.name || "(unnamed PDF)", error);
        failedFiles += 1;
      }
      continue;
    }

    skippedFiles += 1;
  }

  if (!addedItems) {
    setStatus("No supported image/PDF content could be loaded.");
    return;
  }

  isCameraPreviewActive = false;
  setCurrentImageByIndex(images.length - 1);

  const itemWord = addedItems === 1 ? "item" : "items";
  const detailText = messages.length ? ` PDFs: ${messages.join(", ")}.` : "";
  const skippedText = skippedFiles
    ? ` Skipped ${skippedFiles} unsupported ${skippedFiles === 1 ? "file" : "files"}.`
    : "";
  const failedText = failedFiles
    ? ` Failed to read ${failedFiles} ${failedFiles === 1 ? "file" : "files"}.`
    : "";

  setStatus(
    `Added ${addedItems} ${itemWord}. Viewing ${currentImageIndex + 1}/${images.length}.${detailText}${skippedText}${failedText}`
  );
}

function gotoPreviousImage() {
  if (isTranscribing || images.length < 2) {
    return;
  }

  isCameraPreviewActive = false;
  const nextIndex = (currentImageIndex - 1 + images.length) % images.length;
  setCurrentImageByIndex(nextIndex);
  setStatus(`Viewing image ${currentImageIndex + 1}/${images.length}.`);
}

function gotoNextImage() {
  if (isTranscribing || images.length < 2) {
    return;
  }

  isCameraPreviewActive = false;
  const nextIndex = (currentImageIndex + 1) % images.length;
  setCurrentImageByIndex(nextIndex);
  setStatus(`Viewing image ${currentImageIndex + 1}/${images.length}.`);
}

function removeCurrentImage() {
  if (isTranscribing || !images.length) {
    return;
  }

  const indexToRemove = currentImageIndex < 0 ? images.length - 1 : currentImageIndex;
  const [removed] = images.splice(indexToRemove, 1);

  if (!images.length) {
    setCurrentImageByIndex(-1);
    setStatus(`Removed ${removed?.sourceLabel || "image"}. Queue is now empty.`);
    return;
  }

  const nextIndex = Math.min(indexToRemove, images.length - 1);
  setCurrentImageByIndex(nextIndex);
  setStatus(`Removed ${removed?.sourceLabel || "image"}. Viewing ${currentImageIndex + 1}/${images.length}.`);
}

async function transcribeImageRecord(record, displayIndex, total, progressBase = 0, progressSpan = 1) {
  const updateTaskProgress = (localProgress) => {
    setProgress(clampProgress(progressBase + progressSpan * clampProgress(localProgress)));
  };

  updateTaskProgress(0);
  setStatus(`Running OCR on image ${displayIndex}/${total}...`);

  const targetSettingsKey = getTargetSettingsKeyForRecord(record);
  const nativePdfText = (record.pdfNativeText || "").trim();
  if (targetSettingsKey === "native-text" && nativePdfText) {
    record.rawOcrText = nativePdfText;
    record.ocrText = formatDisplayText(nativePdfText);
    record.confidence = NaN;
    record.hasOcr = true;
    record.regionCount = 0;
    record.ocrSettingsKey = targetSettingsKey;

    if (getCurrentImage()?.id === record.id) {
      syncResultFromCurrentImage();
    }

    updateTaskProgress(1);
    setStatus(`Used embedded PDF text for image ${displayIndex}/${total}.`);
    return;
  }

  const language = getSelectedLanguageCode();
  const psm = Number(psmSelect.value);
  const readingMode = readingOrderSelect.value;

  const { text, confidence, regionCount } = await transcribeWithLayoutMode(
    record.dataUrl,
    language,
    psm,
    readingMode,
    updateTaskProgress
  );

  record.rawOcrText = text || "No text found in the provided image.";
  record.ocrText = formatDisplayText(record.rawOcrText);
  record.confidence = confidence;
  record.hasOcr = true;
  record.regionCount = regionCount;
  record.ocrSettingsKey = targetSettingsKey;

  if (getCurrentImage()?.id === record.id) {
    syncResultFromCurrentImage();
  }

  if (regionCount > 1) {
    setStatus(`OCR complete for image ${displayIndex}/${total} (two-column mode).`);
  } else {
    setStatus(`OCR complete for image ${displayIndex}/${total}.`);
  }

  updateTaskProgress(1);
}

async function handleFileInputSelection(inputEl) {
  const files = inputEl?.files;
  const fileCount = files?.length || 0;

  if (!fileCount) {
    return;
  }

  setStatus(`Loading ${fileCount} selected ${fileCount === 1 ? "file" : "files"}...`);

  try {
    await addFiles(files);
  } catch (error) {
    console.error("File selection handling failed:", error);
    setStatus("Could not process the selected file(s). Try another file.");
  } finally {
    inputEl.value = "";
  }
}

fileInput.addEventListener("change", async (event) => {
  await handleFileInputSelection(event.target);
});

// Some mobile browsers dispatch `input` for file pickers more reliably than `change`.
fileInput.addEventListener("input", async (event) => {
  await handleFileInputSelection(event.target);
});

dropZone.addEventListener("click", () => fileInput.click());
dropZone.addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    fileInput.click();
  }
});

["dragenter", "dragover"].forEach((eventName) => {
  dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    event.stopPropagation();
    dropZone.classList.add("active");
  });
});

["dragleave", "drop"].forEach((eventName) => {
  dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    event.stopPropagation();
    dropZone.classList.remove("active");
  });
});

dropZone.addEventListener("drop", async (event) => {
  await addFiles(event.dataTransfer.files);
});

languageDropdownBtn.addEventListener("click", () => {
  if (languageDropdownMenu.hidden) {
    openLanguageDropdown();
  } else {
    closeLanguageDropdown();
  }
});

for (const checkbox of languageCheckboxes) {
  checkbox.addEventListener("change", (event) => {
    const checkedCount = languageCheckboxes.filter((item) => item.checked).length;

    if (checkedCount === 0) {
      event.target.checked = true;
    }

    updateLanguageDropdownLabel();
  });
}

document.addEventListener("click", (event) => {
  if (!languageMultiSelect.contains(event.target)) {
    closeLanguageDropdown();
  }
});

prevImageBtn.addEventListener("click", gotoPreviousImage);
nextImageBtn.addEventListener("click", gotoNextImage);
removeImageBtn.addEventListener("click", removeCurrentImage);

document.addEventListener("keydown", (event) => {
  const targetTag = event.target?.tagName;
  if (targetTag === "INPUT" || targetTag === "SELECT" || targetTag === "TEXTAREA") {
    return;
  }

  if (event.key === "ArrowLeft") {
    gotoPreviousImage();
  } else if (event.key === "ArrowRight") {
    gotoNextImage();
  } else if (event.key.toLowerCase() === "x") {
    removeCurrentImage();
  } else if (event.key === "Escape") {
    closeLanguageDropdown();
  }
});

startCameraBtn.addEventListener("click", async () => {
  if (!navigator.mediaDevices?.getUserMedia) {
    setStatus("Camera access is not supported in this browser.");
    return;
  }

  try {
    activeStream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: "environment" },
        width: { ideal: 1920 },
        height: { ideal: 1080 }
      },
      audio: false
    });

    cameraFeed.srcObject = activeStream;
    isCameraPreviewActive = true;
    refreshPreview();

    captureBtn.disabled = false;
    stopCameraBtn.disabled = false;
    startCameraBtn.disabled = true;

    if (images.length > 0) {
      setStatus(`Camera running. ${images.length} saved image(s). Capture to add more.`);
    } else {
      setStatus("Camera running. Capture to add image(s).");
    }
  } catch {
    setStatus("Could not start camera. Check browser permissions.");
  }
});

captureBtn.addEventListener("click", () => {
  if (!activeStream || !cameraFeed.videoWidth || !cameraFeed.videoHeight) {
    setStatus("Camera frame is not ready yet.");
    return;
  }

  captureCanvas.width = cameraFeed.videoWidth;
  captureCanvas.height = cameraFeed.videoHeight;
  const ctx = captureCanvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(cameraFeed, 0, 0, captureCanvas.width, captureCanvas.height);

  const dataUrl = captureCanvas.toDataURL("image/png");
  images.push(createImageRecord(dataUrl));
  imageIdSeed += 1;
  setCurrentImageByIndex(images.length - 1);

  isCameraPreviewActive = true;
  refreshPreview();
  setStatus(`Captured image ${images.length}. Stop camera to review with arrows.`);
});

stopCameraBtn.addEventListener("click", () => {
  if (activeStream) {
    activeStream.getTracks().forEach((track) => track.stop());
    activeStream = null;
  }

  cameraFeed.srcObject = null;
  isCameraPreviewActive = false;

  startCameraBtn.disabled = false;
  captureBtn.disabled = true;
  stopCameraBtn.disabled = true;

  refreshPreview();

  if (images.length > 0) {
    setStatus(`Camera stopped. Viewing image ${currentImageIndex + 1}/${images.length}.`);
  } else {
    setStatus("Camera stopped. Provide image(s).");
  }
});

transcribeBtn.addEventListener("click", async () => {
  const current = getCurrentImage();
  if (!current || isTranscribing) {
    return;
  }

  if (!window.Tesseract) {
    setStatus("OCR engine failed to load. Check your internet connection.");
    return;
  }

  isTranscribing = true;
  prevImageBtn.disabled = true;
  nextImageBtn.disabled = true;
  updateTranscribeState();

  try {
    await transcribeImageRecord(current, currentImageIndex + 1, images.length, 0, 1);
  } catch {
    setStatus("OCR failed. Try another image or language setting.");
    setProgress(0);
    setConfidence(NaN);
  } finally {
    isTranscribing = false;
    prevImageBtn.disabled = false;
    nextImageBtn.disabled = false;
    updateTranscribeState();
  }
});

transcribeAllBtn.addEventListener("click", async () => {
  if (!images.length || isTranscribing) {
    return;
  }

  if (!window.Tesseract) {
    setStatus("OCR engine failed to load. Check your internet connection.");
    return;
  }

  isTranscribing = true;
  isCameraPreviewActive = false;
  prevImageBtn.disabled = true;
  nextImageBtn.disabled = true;
  updateTranscribeState();
  setProgress(0);

  let completed = 0;
  let failed = 0;
  let skipped = 0;
  const total = images.length;

  for (let i = 0; i < total; i += 1) {
    setCurrentImageByIndex(i);
    const record = images[i];
    const pageBase = i / total;
    const pageSpan = 1 / total;
    const targetKey = getTargetSettingsKeyForRecord(record);

    if (record.hasOcr && record.ocrSettingsKey === targetKey) {
      skipped += 1;
      setProgress(pageBase + pageSpan);
      setStatus(`Skipping image ${i + 1}/${total} (already transcribed for current settings).`);
      continue;
    }

    try {
      await transcribeImageRecord(record, i + 1, total, pageBase, pageSpan);
      completed += 1;
    } catch {
      failed += 1;
      setStatus(`OCR failed on image ${i + 1}/${total}. Continuing...`);
    }
  }

  if (completed > 0 && getCurrentImage()) {
    syncResultFromCurrentImage();
  }

  if (completed > 0) {
    setProgress(1);
  }

  setStatus(
    failed
      ? `Transcribe all complete: ${completed} transcribed, ${skipped} skipped, ${failed} failed.`
      : `Transcribe all complete: ${completed} transcribed, ${skipped} skipped.`
  );

  isTranscribing = false;
  prevImageBtn.disabled = false;
  nextImageBtn.disabled = false;
  updateTranscribeState();
});

copyBtn.addEventListener("click", async () => {
  if (!resultText.value.trim()) {
    return;
  }

  try {
    await navigator.clipboard.writeText(resultText.value);
    setStatus("Transcribed text copied to clipboard.");
  } catch {
    setStatus("Copy failed. Your browser may block clipboard access.");
  }
});

downloadBtn.addEventListener("click", () => {
  if (!resultText.value.trim()) {
    return;
  }

  const blob = new Blob([resultText.value], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `transcription-${currentImageIndex + 1}.txt`;
  a.click();
  URL.revokeObjectURL(url);
  setStatus("Downloaded transcription file.");
});

copyAllBtn.addEventListener("click", async () => {
  const combinedText = getCombinedTranscriptionText();
  if (!combinedText) {
    return;
  }

  try {
    await navigator.clipboard.writeText(combinedText);
    setStatus("Copied combined transcription for all images.");
  } catch {
    setStatus("Copy all failed. Your browser may block clipboard access.");
  }
});

downloadAllBtn.addEventListener("click", () => {
  const combinedText = getCombinedTranscriptionText();
  if (!combinedText) {
    return;
  }

  const blob = new Blob([combinedText], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "transcriptions-all.txt";
  a.click();
  URL.revokeObjectURL(url);
  setStatus("Downloaded transcriptions-all.txt");
});

clearBtn.addEventListener("click", () => {
  const current = getCurrentImage();
  if (!current) {
    setStatus("Waiting for image(s)...");
    return;
  }

  current.rawOcrText = "";
  current.ocrText = "";
  current.confidence = NaN;
  current.hasOcr = false;
  current.regionCount = 0;
  current.ocrSettingsKey = "";

  syncResultFromCurrentImage();
  setStatus(`Cleared OCR text for image ${currentImageIndex + 1}/${images.length}.`);
});

cleanupTextToggle.addEventListener("change", () => {
  const current = getCurrentImage();
  if (!current || !current.hasOcr) {
    return;
  }

  syncResultFromCurrentImage();
  setStatus(
    cleanupTextToggle.checked
      ? "Text cleanup enabled for OCR output."
      : "Text cleanup disabled for OCR output."
  );
});

window.addEventListener("beforeunload", () => {
  if (activeStream) {
    activeStream.getTracks().forEach((track) => track.stop());
  }

  if (persistentOcrWorker && typeof persistentOcrWorker.terminate === "function") {
    persistentOcrWorker.terminate();
  }
});

window.addEventListener("resize", () => {
  updateDefaultTextareaHeight();
});

refreshPreview();
updateLanguageDropdownLabel();
setStatus("Waiting for image(s)...");
