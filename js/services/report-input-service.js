(function initReportInputService(global) {
  'use strict';

  const { OCR_API_URL } = global.JKGLData;
  const { loadScriptOnce } = global.JKGLCore;
  const API_BASE = global.location.protocol === 'file:' ? 'http://localhost:8765' : '';

  const callOcr = async (file) => {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('mode', 'detail');
    formData.append('quality', 'accurate');
    const response = await fetch(OCR_API_URL, { method: 'POST', body: formData });
    if (!response.ok) throw new Error(await response.text());
    const data = await response.json();
    return {
      rawText: String(data.rawText || '').trim(),
      ocrLines: Array.isArray(data.lines) ? data.lines : []
    };
  };

  const pageText = async (page) => {
    const textContent = await page.getTextContent();
    const rows = new Map();
    textContent.items.forEach((item) => {
      const y = Math.round(item.transform[5]);
      if (!rows.has(y)) rows.set(y, []);
      rows.get(y).push(item);
    });
    return Array.from(rows.keys())
      .sort((a, b) => b - a)
      .map((y) => rows.get(y)
        .sort((a, b) => a.transform[4] - b.transform[4])
        .map((item) => item.str)
        .join(' '))
      .join('\n')
      .trim();
  };

  const renderPageFile = async (page, pageNumber, sourceName) => {
    const viewport = page.getViewport({ scale: 1.8 });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const context = canvas.getContext('2d', { alpha: false });
    await page.render({ canvasContext: context, viewport }).promise;
    const blob = await new Promise((resolve, reject) => {
      canvas.toBlob((value) => value ? resolve(value) : reject(new Error('PDF 页面转图失败。')), 'image/jpeg', 0.92);
    });
    return new File([blob], `${sourceName}-page-${pageNumber}.jpg`, { type: 'image/jpeg' });
  };

  const extractPdfText = async (file, onProgress = () => {}) => {
    await loadScriptOnce('pdfjs-script', 'vendor/pdf.min.js');
    const pdfjsLib = global['pdfjs-dist/build/pdf'];
    if (!pdfjsLib) throw new Error('PDF 解析组件加载失败。');
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';
    const pdf = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
    const chunks = [];
    let extraction = 'pdf-text';

    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      onProgress(`正在解析 PDF 第 ${pageNumber}/${pdf.numPages} 页...`);
      const page = await pdf.getPage(pageNumber);
      let text = await pageText(page);
      if (text.replace(/\s+/g, '').length < 20) {
        extraction = 'pdf-ocr';
        const ocrResult = await callOcr(await renderPageFile(page, pageNumber, file.name.replace(/\.pdf$/i, '')));
        text = ocrResult.rawText;
      }
      if (text) chunks.push(text);
    }

    return { rawText: chunks.join('\n\n').trim(), extraction, pageCount: pdf.numPages };
  };

  const extractReportText = async (file, onProgress = () => {}) => {
    const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
    if (isPdf) return extractPdfText(file, onProgress);
    onProgress('正在识别报告图片...');
    const ocrResult = await callOcr(file);
    return { ...ocrResult, extraction: 'image-ocr', pageCount: 1 };
  };

  const uploadReportFile = async (file) => {
    const formData = new FormData();
    formData.append('file', file);
    const response = await fetch(`${API_BASE}/api/report-files`, { method: 'POST', body: formData });
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  };

  global.JKGLReportInput = Object.freeze({ extractReportText, uploadReportFile });
})(window);
