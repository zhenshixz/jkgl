(function initDataService(global) {
  'use strict';

  const STORAGE_KEY = 'jkgl-exam-manager-v1';
  const API_BASE = global.location.protocol === 'file:' ? 'http://localhost:8765' : '';
  const DATA_API_URL = `${API_BASE}/api/data`;
  const OCR_API_URL = `${API_BASE}/api/ocr`;

  const fetchWithTimeout = (url, options = {}, timeoutMs = 5000) => {
    const controller = new AbortController();
    const timer = global.setTimeout(() => controller.abort(), timeoutMs);
    return fetch(url, { ...options, signal: controller.signal })
      .finally(() => global.clearTimeout(timer));
  };

  const cloneFallback = (fallback) => JSON.parse(JSON.stringify(fallback));

  const dataRepository = {
    readLocal(fallback) {
      try {
        const saved = global.localStorage.getItem(STORAGE_KEY);
        return saved ? JSON.parse(saved) : cloneFallback(fallback);
      } catch (error) {
        console.warn('本地缓存读取失败，已使用空数据启动。', error);
        return cloneFallback(fallback);
      }
    },

    writeLocal(payload) {
      global.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    },

    async loadRemote(timeoutMs = 3000) {
      const response = await fetchWithTimeout(DATA_API_URL, {}, timeoutMs);
      if (!response.ok) throw new Error(`数据加载失败 (${response.status})`);
      return response.json();
    },

    async saveRemote(payload, timeoutMs = 6000) {
      const response = await fetchWithTimeout(DATA_API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      }, timeoutMs);
      if (!response.ok) throw new Error(`数据保存失败 (${response.status})`);
      return response.json();
    },

    saveForUnload(payload) {
      if (!global.navigator.sendBeacon) return false;
      const body = new Blob([JSON.stringify(payload)], { type: 'application/json' });
      return global.navigator.sendBeacon(DATA_API_URL, body);
    }
  };

  const createSaveQueue = ({ repository, debounceMs = 500, onError } = {}) => {
    let timer = null;
    let pendingFactory = null;
    let saveChain = Promise.resolve();
    let latestPayload = null;

    const takeSnapshot = () => {
      if (!pendingFactory) return null;
      const factory = pendingFactory;
      pendingFactory = null;
      return factory();
    };

    const enqueueRemoteSave = (payload) => {
      saveChain = saveChain
        .catch(() => undefined)
        .then(() => repository.saveRemote(payload))
        .catch((error) => {
          if (onError) onError(error);
          else console.error('同步数据到后端失败:', error);
        });
      return saveChain;
    };

    const flush = () => {
      if (timer) {
        global.clearTimeout(timer);
        timer = null;
      }
      const payload = takeSnapshot();
      if (!payload) return saveChain;
      latestPayload = payload;
      repository.writeLocal(payload);
      return enqueueRemoteSave(payload);
    };

    return {
      schedule(payloadFactory) {
        pendingFactory = payloadFactory;
        if (timer) global.clearTimeout(timer);
        timer = global.setTimeout(flush, debounceMs);
      },

      flush,

      flushForUnload() {
        if (timer) {
          global.clearTimeout(timer);
          timer = null;
        }
        const payload = takeSnapshot() || latestPayload;
        if (!payload) return;
        latestPayload = payload;
        try {
          repository.writeLocal(payload);
          repository.saveForUnload(payload);
        } catch (error) {
          console.error('页面关闭前保存失败:', error);
        }
      }
    };
  };

  global.JKGLData = Object.freeze({
    STORAGE_KEY,
    DATA_API_URL,
    OCR_API_URL,
    fetchWithTimeout,
    dataRepository,
    createSaveQueue
  });
})(window);
