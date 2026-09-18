(() => {
  // ============================================================================
  // Kalodata Video Downloader v2.0 - Enhanced Content Script
  // ============================================================================
  
  // Remove previous instances to avoid duplicates
  if (window.__kaloConsole?.remove) {
    window.__kaloConsole.remove();
  }

  // ============================================================================
  // CONFIGURATION
  // ============================================================================

  const CONFIG = {
    APP_NAME: "🎬 Kalodata Video Downloader",
    VERSION: "2.0.0",
    VIDEO_CDN_URL: "https://live.kalocdn.com/video",
    MAX_RETRIES: 5,
    RETRY_DELAYS: [500, 1000, 2000, 4000, 8000],
    WARMUP_DELAY: 1200,
    CONCURRENT_DOWNLOADS: 3,
    CONTAINER_SELECTOR: "div.bg-kalo-container.rounded-md.p-4",
    TABLE_ROW_SELECTOR: "tr[data-row-key]",
    TITLE_SELECTOR: ".line-clamp-2",
    COVER_SELECTOR: ".Layout-VideoCover"
  };

  // ============================================================================
  // UTILITIES
  // ============================================================================

  const Utils = {
    delay(ms) {
      return new Promise(resolve => setTimeout(resolve, ms));
    },

    sanitizeText(text) {
      return (text || "").replace(/\s+/g, " ").trim();
    },

    extractUrl(styleText) {
      const match = /background-image:\s*url\(["']?(.*?)["']?\)/i.exec(styleText || "");
      return match ? match[1] : "";
    },

    buildVideoUrl(videoId) {
      return `${CONFIG.VIDEO_CDN_URL}/${videoId}.mp4`;
    },

    copyToClipboard(text) {
      return navigator.clipboard.writeText(text)
        .then(() => true)
        .catch(err => {
          Logger.log(`❌ Failed to copy: ${err.message}`);
          return false;
        });
    },

    timestamp() {
      return new Date().toLocaleTimeString();
    }
  };

  // ============================================================================
  // DATA PARSER
  // ============================================================================

  const DataParser = {
    extractProductId(row) {
      // The product id is unique per product+shop pair (same product, different
      // shop => different id), exactly what we want in the filename.

      // 1) Multi-product listing pages: each row links to its own product via a
      //    /product/detail?id=... URL. Pull the numeric `id` from that link.
      try {
        const links = Array.from(row.querySelectorAll("a[href]"));
        for (const link of links) {
          const href = link.getAttribute("href") || link.href || "";
          if (!/product\/detail/i.test(href)) continue;
          const match = /[?&]id=(\d+)/.exec(href);
          if (match) return match[1];
        }
      } catch (err) {
        console.warn("[Kalodata] Failed to extract product id from row:", err);
      }

      // 2) Product detail page (kalodata.com/product/detail?id=...): the whole
      //    "Video & Quảng cáo" table belongs to one product, whose id is the
      //    page URL's `id` param — shared by every video row.
      try {
        if (/\/product\/detail/i.test(location.pathname)) {
          const pageId = new URLSearchParams(location.search).get("id");
          if (pageId && /^\d+$/.test(pageId)) return pageId;
        }
      } catch (err) {
        console.warn("[Kalodata] Failed to extract product id from URL:", err);
      }

      return "";
    },

    findVideoContainer() {
      // Try multiple selectors to find the container
      let containers = Array.from(document.querySelectorAll(CONFIG.CONTAINER_SELECTOR));
      
      // If not found with primary selector, try alternative selectors
      if (!containers.length) {
        containers = Array.from(document.querySelectorAll("[class*='bg-kalo-container']"));
      }
      
      if (!containers.length) {
        containers = Array.from(document.querySelectorAll("div[class*='kalo-container']"));
      }
      
      if (!containers.length) {
        return null;
      }

      // The Video & Ads block is the ONLY section whose table uses video-cover
      // thumbnails (.Layout-VideoCover). This uniquely separates it from the
      // Creator table (round avatars) and the Live table (no rows), and avoids
      // the previous loose-regex bug where the "Tổng quan" section matched
      // `video.*&.*ad` (e.g. "...xe hơi & xe máy ... vanadi...") and returned a
      // block that has no data-row-key rows -> "No videos loaded".
      const byCover = containers.find(c =>
        c.querySelector(CONFIG.TABLE_ROW_SELECTOR) && c.querySelector(CONFIG.COVER_SELECTOR)
      );
      if (byCover) {
        return byCover;
      }

      // Fallback: precise title match, but only accept a block that actually
      // contains a data table (so non-table sections can never win).
      const byTitle = containers.find(c => {
        if (!c.querySelector(CONFIG.TABLE_ROW_SELECTOR)) return false;
        const text = (c.textContent || "").toLowerCase();
        return /video\s*&\s*qu[àả]ng\s*c[áa]o|video\s*&\s*ads?\b/.test(text);
      });

      return byTitle || null;
    },

    parseTableRows() {
      const container = this.findVideoContainer();
      if (!container) {
        // Debug info
        const allContainers = document.querySelectorAll("div[class*='container']");
        console.warn(`[Kalodata] Container not found. Found ${allContainers.length} potential containers`);
        Array.from(allContainers).slice(0, 5).forEach((c, i) => {
          console.log(`  [${i}] classes:`, c.className, "text:", c.textContent?.substring(0, 100));
        });
        
        return {
          items: [],
          note: "❌ Video & Quảng cáo block not found. Please scroll and refresh.",
          isEmpty: true
        };
      }

      // Try to find rows in table
      let rows = Array.from(container.querySelectorAll(CONFIG.TABLE_ROW_SELECTOR));
      
      // If no rows found, try alternative selector
      if (!rows.length) {
        rows = Array.from(container.querySelectorAll("tr[data-row-key], tbody tr, [role='row']"));
      }
      
      // Debug: Check if we have any table elements
      if (!rows.length) {
        const tables = container.querySelectorAll("table, [role='grid'], [role='table']");
        const trElements = container.querySelectorAll("tr");
        console.warn(`[Kalodata] No rows found. Tables: ${tables.length}, TR elements: ${trElements.length}`);
      }
      
      console.log(`[Kalodata] Found ${rows.length} rows in container`);
      
      if (!rows.length) {
        return {
          items: [],
          note: "⚠️ No videos loaded. Please scroll down the table and click Refresh.",
          isEmpty: true
        };
      }

      const seen = new Set();
      const items = [];

      rows.forEach((row, idx) => {
        try {
          const videoId = row.getAttribute("data-row-key");
          if (!videoId || seen.has(videoId)) return;
          seen.add(videoId);

          const cells = Array.from(row.querySelectorAll("td"));
          if (cells.length < 2) {
            console.warn(`[Kalodata] Row ${idx} has only ${cells.length} cells, expected >= 2`);
            return;
          }
          
          const contentCell = cells[1];

          const titleEl = contentCell?.querySelector(CONFIG.TITLE_SELECTOR);
          const title = Utils.sanitizeText(titleEl?.textContent || "");

          const coverEl = contentCell?.querySelector(CONFIG.COVER_SELECTOR);
          const cover = Utils.extractUrl(coverEl?.getAttribute("style") || "");

          const productId = this.extractProductId(row);

          items.push({
            id: videoId,
            productId,
            title: title || "Untitled",
            cover: cover || "",
            revenue: Utils.sanitizeText(cells[2]?.textContent || "-"),
            views: Utils.sanitizeText(cells[3]?.textContent || "-"),
            itemSold: Utils.sanitizeText(cells[4]?.textContent || "-"),
            publishDate: Utils.sanitizeText(cells[5]?.textContent || "-"),
            coverEl
          });
        } catch (err) {
          console.error(`[Kalodata] Error parsing row ${idx}:`, err);
        }
      });

      console.log(`[Kalodata] Parsed ${items.length} valid items`);

      return {
        items,
        note: "",
        isEmpty: items.length === 0
      };
    }
  };

  // ============================================================================
  // LOGGER
  // ============================================================================

  let logBox = null;

  const Logger = {
    init(element) {
      logBox = element;
    },

    log(message) {
      if (!logBox) return;
      const line = document.createElement("div");
      line.textContent = `[${Utils.timestamp()}] ${message}`;
      line.style.wordBreak = "break-word";
      logBox.appendChild(line);
      logBox.scrollTop = logBox.scrollHeight;
    },

    warn(message, error) {
      this.log(`⚠️ ${message}${error ? ': ' + error.message : ''}`);
    }
  };

  // ============================================================================
  // STATUS BAR
  // ============================================================================

  const StatusBar = {
    setStatus(videoId, text, status) {
      const element = document.getElementById(`kalo-status-${videoId}`);
      if (element) {
        element.textContent = text;
        element.className = `kalo-status kalo-status-${status}`.trim();
      }
    }
  };

  // ============================================================================
  // DOWNLOAD MANAGER
  // ============================================================================

  const DownloadManager = {
    async warmUpVideo(videoItem) {
      if (!videoItem?.coverEl) return;
      try {
        videoItem.coverEl.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true, cancelable: true }));
        videoItem.coverEl.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, cancelable: true }));
        await Utils.delay(CONFIG.WARMUP_DELAY);
      } catch (err) {
        Logger.warn(`Failed to warm up ${videoItem.id}`, err);
      }
    },

    async warmUpBatch(items) {
      if (!items?.length) {
        Logger.log("ℹ️ No items to warm up.");
        return;
      }

      Logger.log(`🔥 Warming up ${items.length} video${items.length !== 1 ? 's' : ''}...`);
      for (const item of items) {
        StatusBar.setStatus(item.id, "Warming...", "warming");
        await this.warmUpVideo(item);
      }
      Logger.log("✅ Warm-up completed.");
    },

    async downloadVideo(videoItem) {
      if (!videoItem?.id) return false;

      const url = Utils.buildVideoUrl(videoItem.id);
      
      for (let attempt = 1; attempt <= CONFIG.MAX_RETRIES; attempt++) {
        try {
          Logger.log(`📥 [${attempt}/${CONFIG.MAX_RETRIES}] Downloading ${videoItem.id}...`);
          StatusBar.setStatus(videoItem.id, `Downloading... (${attempt})`, "downloading");

          const response = await fetch(url, { 
            mode: "cors",
            signal: AbortSignal.timeout(30000)
          });
          
          if (!response.ok) {
            const errorText = await response.text().catch(() => "");
            
            if (response.status === 404 || errorText.includes("removed") || errorText.includes("hidden")) {
              Logger.log(`🚫 Removed/Hidden: ${videoItem.id}`);
              StatusBar.setStatus(videoItem.id, "Removed", "removed");
              return false;
            }
            
            throw new Error(`HTTP ${response.status}`);
          }

          const blob = await response.blob();
          this.triggerDownload(blob, videoItem);
          
          Logger.log(`✅ Downloaded: ${videoItem.id}`);
          StatusBar.setStatus(videoItem.id, "✓ Done", "success");
          return true;

        } catch (error) {
          const isLast = attempt === CONFIG.MAX_RETRIES;
          const waitTime = CONFIG.RETRY_DELAYS[Math.min(attempt - 1, CONFIG.RETRY_DELAYS.length - 1)];
          
          Logger.log(`⚠️ Attempt ${attempt} failed: ${error.message}`);
          StatusBar.setStatus(videoItem.id, `Retry (${attempt}/${CONFIG.MAX_RETRIES})`, "retrying");

          if (!isLast) {
            Logger.log(`⏳ Waiting ${waitTime}ms...`);
            await Utils.delay(waitTime);
            await this.warmUpVideo(videoItem);
          }
        }
      }

      Logger.log(`❌ Failed: ${videoItem.id}`);
      StatusBar.setStatus(videoItem.id, "✗ Failed", "failed");
      return false;
    },

    triggerDownload(blob, videoItem) {
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      // Filename: {productId}_{videoId}.mp4. Fall back to {videoId}.mp4 when the
      // product id could not be found in the row, so downloads never break.
      const namePrefix = videoItem.productId ? `${videoItem.productId}_` : "";
      link.download = `${namePrefix}${videoItem.id}.mp4`;
      link.style.display = "none";
      
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      
      setTimeout(() => URL.revokeObjectURL(url), 100);
    },

    async downloadBatch(items, label = "videos") {
      if (!items?.length) {
        Logger.log("ℹ️ No items to download.");
        return { success: 0, failed: 0 };
      }

      const stats = { success: 0, failed: 0, total: items.length };
      let index = 0;
      let inFlight = 0;

      Logger.log(`🚀 Starting ${stats.total} ${label} (${CONFIG.CONCURRENT_DOWNLOADS} concurrent)...`);

      return new Promise((resolve) => {
        const processNext = () => {
          while (inFlight < CONFIG.CONCURRENT_DOWNLOADS && index < items.length) {
            const item = items[index++];
            inFlight++;

            this.downloadVideo(item)
              .then(success => {
                if (success) stats.success++;
                else stats.failed++;
              })
              .catch(err => {
                stats.failed++;
                Logger.log(`💥 Error [${item.id}]: ${err.message}`);
                StatusBar.setStatus(item.id, "✗ Error", "failed");
              })
              .finally(() => {
                inFlight--;
                setTimeout(processNext, 300);
                
                if (index >= items.length && inFlight === 0) {
                  Logger.log(`\n📊 Summary: ✅ ${stats.success} | ❌ ${stats.failed} | Total: ${stats.total}`);
                  resolve(stats);
                }
              });
          }
        };

        processNext();
      });
    }
  };

  // ============================================================================
  // UI STATE
  // ============================================================================

  let currentItems = [];
  let selectedIds = new Set();
  let listContainer = null;
  let observerHandle = null;
  let observedContainer = null;
  let observerDebounceTimer = null;
  let isRendering = false;
  let lastRenderAt = 0;

  // ============================================================================
  // UI MANAGER
  // ============================================================================

  const UIManager = {
    render() {
      if (isRendering) return;
      isRendering = true;
      try {
        const { items, note, isEmpty } = DataParser.parseTableRows();
        const previousSelectedIds = new Set(selectedIds);
        currentItems = items;
        selectedIds.clear();
        lastRenderAt = Date.now();

        listContainer.innerHTML = "";

        // Header Row
        const header = document.createElement("div");
        header.className = "kalo-row kalo-header";
        header.innerHTML = `
          <div class="kalo-col kalo-col-check"><input type="checkbox" id="kalo-select-all" title="Select/Deselect all"></div>
          <div class="kalo-col kalo-col-content">Video Content</div>
          <div class="kalo-col">Revenue</div>
          <div class="kalo-col">Views</div>
          <div class="kalo-col">Sold</div>
          <div class="kalo-col">Date</div>
          <div class="kalo-col">Status</div>
        `;
        listContainer.appendChild(header);

        // Count Info
        const counter = document.createElement("div");
        counter.className = "kalo-counter";
        counter.textContent = `Found: ${items.length} video${items.length !== 1 ? 's' : ''}`;
        listContainer.appendChild(counter);

        if (isEmpty) {
          const emptyEl = document.createElement("div");
          emptyEl.className = "kalo-empty";
          emptyEl.textContent = note || "No data found.";
          listContainer.appendChild(emptyEl);
          return;
        }

        // Video Rows
        items.forEach(item => {
          const row = this.createVideoRow(item, previousSelectedIds.has(item.id));
          listContainer.appendChild(row);
        });

        // Select All Handler
        const selectAllCheckbox = document.getElementById("kalo-select-all");
        selectAllCheckbox?.addEventListener("change", (e) => {
          const checkboxes = listContainer.querySelectorAll(".kalo-row:not(.kalo-header) input[type='checkbox']");
          checkboxes.forEach((cb, idx) => {
            cb.checked = e.target.checked;
            const videoItem = items[idx];
            if (videoItem) {
              if (e.target.checked) selectedIds.add(videoItem.id);
              else selectedIds.delete(videoItem.id);
            }
          });
          this.updateSelectAllState();
        });

        this.updateSelectAllState();
        
        // Setup auto-observer for table changes
        this.setupTableObserver();
      } finally {
        isRendering = false;
      }
    },

    updateSelectAllState() {
      const selectAllCheckbox = document.getElementById("kalo-select-all");
      if (!selectAllCheckbox) return;

      if (!currentItems.length) {
        selectAllCheckbox.checked = false;
        selectAllCheckbox.indeterminate = false;
        return;
      }

      const selectedCount = currentItems.reduce((count, item) => (
        selectedIds.has(item.id) ? count + 1 : count
      ), 0);

      selectAllCheckbox.checked = selectedCount === currentItems.length;
      selectAllCheckbox.indeterminate = selectedCount > 0 && selectedCount < currentItems.length;
    },

    setupTableObserver() {
      const container = DataParser.findVideoContainer();
      if (!container) return;

      if (observerHandle && observedContainer === container) {
        return;
      }

      // Clean up previous observer only when container changes
      if (observerHandle) {
        observerHandle.disconnect();
      }

      // Watch for changes in the table
      const observer = new MutationObserver(() => {
        const panel = document.getElementById("kalo-console-panel");
        if (!panel || panel.classList.contains("hidden")) {
          return;
        }

        // Throttle + debounce to avoid continuous heavy rerenders on reactive pages
        const now = Date.now();
        if (now - lastRenderAt < 1500) {
          return;
        }

        clearTimeout(observerDebounceTimer);
        observerDebounceTimer = setTimeout(() => {
          this.render();
        }, 500);
      });

      observer.observe(container, {
        childList: true,
        subtree: true,
        characterData: false,
        attributes: false
      });

      observerHandle = observer;
      observedContainer = container;
    },

    createVideoRow(item, isChecked = false) {
      const row = document.createElement("div");
      row.className = "kalo-row";

      // Checkbox Column
      const checkCol = document.createElement("div");
      checkCol.className = "kalo-col kalo-col-check";
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = isChecked;
      if (isChecked) {
        selectedIds.add(item.id);
      }
      checkbox.addEventListener("change", (e) => {
        if (e.target.checked) selectedIds.add(item.id);
        else selectedIds.delete(item.id);
        this.updateSelectAllState();
      });
      checkCol.appendChild(checkbox);

      // Content Column
      const contentCol = document.createElement("div");
      contentCol.className = "kalo-col kalo-col-content";
      contentCol.innerHTML = `
        <div class="kalo-content-wrap">
          <div class="kalo-cover" style="background-image:url('${item.cover}')"></div>
          <div class="kalo-info">
            <div class="kalo-title" title="${item.title}">${item.title}</div>
            <div class="kalo-meta">ID: <code>${item.id}</code></div>
            <div class="kalo-actions">
              <button class="kalo-btn kalo-btn-download" data-id="${item.id}" title="Download video">↓ DL</button>
              <button class="kalo-btn kalo-btn-copy" data-url="${Utils.buildVideoUrl(item.id)}" title="Copy link">📋</button>
            </div>
          </div>
        </div>
      `;

      // Data Columns
      const revenueCol = document.createElement("div");
      revenueCol.className = "kalo-col";
      revenueCol.textContent = item.revenue;

      const viewsCol = document.createElement("div");
      viewsCol.className = "kalo-col";
      viewsCol.textContent = item.views;

      const soldCol = document.createElement("div");
      soldCol.className = "kalo-col";
      soldCol.textContent = item.itemSold;

      const dateCol = document.createElement("div");
      dateCol.className = "kalo-col";
      dateCol.textContent = item.publishDate;

      // Status Column
      const statusCol = document.createElement("div");
      statusCol.className = "kalo-col";
      statusCol.innerHTML = `<span class="kalo-status kalo-status-idle" id="kalo-status-${item.id}">Idle</span>`;

      // Assemble Row
      row.appendChild(checkCol);
      row.appendChild(contentCol);
      row.appendChild(revenueCol);
      row.appendChild(viewsCol);
      row.appendChild(soldCol);
      row.appendChild(dateCol);
      row.appendChild(statusCol);

      // Event Handlers
      contentCol.querySelector(".kalo-btn-download")?.addEventListener("click", () => {
        DownloadManager.downloadVideo(item);
      });

      contentCol.querySelector(".kalo-btn-copy")?.addEventListener("click", async (e) => {
        const url = e.target.closest("button").dataset.url;
        const success = await Utils.copyToClipboard(url);
        Logger.log(success ? `📋 Copied: ${item.id}` : `❌ Failed to copy`);
      });

      return row;
    }
  };

  // ============================================================================
  // STYLES
  // ============================================================================

  const STYLES = `
    :root {
      color-scheme: dark;
    }

    #kalo-console-panel {
      position: fixed;
      right: 16px;
      bottom: 16px;
      width: 900px;
      max-height: 75vh;
      overflow: auto;
      z-index: 999999;
      background: #0f1419;
      border: 1px solid #2a3f5f;
      border-radius: 12px;
      box-shadow: 0 20px 50px rgba(0, 0, 0, 0.6);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif;
      padding: 12px;
      color: #e6e9ef;
      max-width: 95vw;
    }

    .kalo-head {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 12px;
      gap: 8px;
      flex-wrap: wrap;
      padding-bottom: 8px;
      border-bottom: 1px solid #2a3f5f;
    }

    .kalo-head strong {
      font-size: 16px;
      font-weight: 700;
      color: #4dbfff;
    }

    .kalo-head-actions {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
      justify-content: flex-end;
    }

    .kalo-list {
      display: flex;
      flex-direction: column;
      gap: 4px;
      margin-top: 8px;
      max-height: 300px;
      overflow-y: auto;
      padding-right: 6px;
    }

    .kalo-row {
      display: grid;
      grid-template-columns: 32px 2fr 0.7fr 0.7fr 0.7fr 0.9fr 0.8fr;
      gap: 8px;
      align-items: center;
      border: 1px solid #2a3f5f;
      border-radius: 6px;
      padding: 6px;
      background: #151a22;
      font-size: 12px;
    }

    .kalo-row:hover {
      background: #1a2233;
      border-color: #3a5f8f;
    }

    .kalo-header {
      background: #1c2836;
      font-weight: 700;
      color: #4dbfff;
      position: sticky;
      top: 0;
      z-index: 10;
    }

    .kalo-counter {
      padding: 6px 8px;
      font-size: 11px;
      color: #9fb4ff;
      background: #1a2233;
      border-radius: 4px;
      margin: 4px 0;
    }

    .kalo-col {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .kalo-col-check {
      display: flex;
      justify-content: center;
    }

    .kalo-col-content {
      white-space: normal;
    }

    .kalo-content-wrap {
      display: flex;
      gap: 8px;
      align-items: flex-start;
    }

    .kalo-cover {
      width: 48px;
      height: 64px;
      background: #202633 center/cover no-repeat;
      border-radius: 4px;
      border: 1px solid #2a3f5f;
      flex-shrink: 0;
    }

    .kalo-info {
      flex: 1;
      min-width: 0;
    }

    .kalo-title {
      font-size: 12px;
      font-weight: 600;
      color: #ffffff;
      margin-bottom: 2px;
      white-space: normal;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      word-break: break-word;
    }

    .kalo-meta {
      font-size: 10px;
      color: #888;
      margin-bottom: 4px;
    }

    .kalo-meta code {
      background: #1a2233;
      padding: 1px 4px;
      border-radius: 2px;
      font-family: monospace;
      color: #4dbfff;
    }

    .kalo-actions {
      display: flex;
      gap: 4px;
      flex-wrap: wrap;
    }

    .kalo-btn {
      padding: 4px 8px;
      border-radius: 4px;
      border: 1px solid #2f6dff;
      background: #2f6dff;
      color: #fff;
      font-size: 10px;
      cursor: pointer;
      transition: all 0.2s ease;
      white-space: nowrap;
    }

    .kalo-btn:hover {
      background: #4d7fff;
      border-color: #4d7fff;
      transform: translateY(-1px);
    }

    .kalo-btn:active {
      transform: translateY(0);
    }

    .kalo-btn-copy {
      padding: 4px 6px;
      background: #1a2233;
      border-color: #4dbfff;
      color: #4dbfff;
      min-width: 24px;
    }

    .kalo-btn-copy:hover {
      background: #2a3f5f;
    }

    .kalo-empty {
      padding: 16px;
      font-size: 12px;
      color: #888;
      border: 1px dashed #2a3f5f;
      border-radius: 6px;
      text-align: center;
      background: #0a0e13;
    }

    .kalo-log-title {
      margin-top: 8px;
      font-size: 11px;
      font-weight: 700;
      color: #4dbfff;
    }

    .kalo-log {
      margin-top: 4px;
      border: 1px solid #2a3f5f;
      border-radius: 6px;
      padding: 6px;
      max-height: 140px;
      overflow-y: auto;
      font-size: 10px;
      color: #c0c8d4;
      background: #0a0e13;
      font-family: "Courier New", monospace;
      line-height: 1.4;
    }

    input[type="checkbox"] {
      accent-color: #2f6dff;
      cursor: pointer;
    }

    .kalo-status {
      display: inline-block;
      padding: 3px 6px;
      border-radius: 12px;
      font-size: 10px;
      font-weight: 600;
      border: 1px solid #2a3f5f;
      white-space: nowrap;
      min-width: 70px;
      text-align: center;
    }

    .kalo-status-idle {
      background: #1a2233;
      color: #888;
    }

    .kalo-status-warming {
      background: #2a2216;
      color: #ffe08a;
      border-color: #3a3530;
    }

    .kalo-status-downloading {
      background: #1a2a36;
      color: #4dbfff;
      border-color: #2a4a6f;
    }

    .kalo-status-retrying {
      background: #2a2216;
      color: #ffb366;
      border-color: #3a3530;
    }

    .kalo-status-success {
      background: #15251c;
      color: #8ff0b2;
      border-color: #264334;
    }

    .kalo-status-failed {
      background: #2a1418;
      color: #ff9aa2;
      border-color: #4a2b2f;
    }

    .kalo-status-removed {
      background: #2a1f12;
      color: #ffcc80;
      border-color: #4a3b2a;
    }

    #kalo-launcher {
      position: fixed;
      right: 16px;
      bottom: 16px;
      width: 48px;
      height: 48px;
      border-radius: 999px;
      border: 2px solid #2f6dff;
      background: linear-gradient(135deg, #1a2233 0%, #0f1419 100%);
      color: #4dbfff;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      z-index: 999998;
      box-shadow: 0 8px 24px rgba(47, 109, 255, 0.25);
      transition: all 0.3s ease;
    }

    #kalo-launcher:hover {
      transform: scale(1.1);
      box-shadow: 0 10px 32px rgba(47, 109, 255, 0.4);
    }

    #kalo-launcher:active {
      transform: scale(0.95);
    }

    #kalo-console-panel.hidden {
      display: none !important;
    }

    @media (max-width: 1024px) {
      #kalo-console-panel {
        width: 85vw;
        max-height: 70vh;
      }

      .kalo-row {
        grid-template-columns: 28px 1.5fr 0.6fr 0.6fr 0.6fr 0.8fr 0.7fr;
        font-size: 11px;
      }
    }

    .kalo-list::-webkit-scrollbar,
    .kalo-log::-webkit-scrollbar {
      width: 6px;
    }

    .kalo-list::-webkit-scrollbar-track,
    .kalo-log::-webkit-scrollbar-track {
      background: transparent;
    }

    .kalo-list::-webkit-scrollbar-thumb,
    .kalo-log::-webkit-scrollbar-thumb {
      background: #2a3f5f;
      border-radius: 3px;
    }

    .kalo-list::-webkit-scrollbar-thumb:hover,
    .kalo-log::-webkit-scrollbar-thumb:hover {
      background: #3a4f7f;
    }
  `;

  // ============================================================================
  // INITIALIZATION
  // ============================================================================

  function initializePanel() {
    const panel = document.createElement("div");
    panel.id = "kalo-console-panel";
    panel.innerHTML = `
      <div class="kalo-head">
        <strong>${CONFIG.APP_NAME}</strong>
        <div class="kalo-head-actions">
          <button class="kalo-btn" id="kalo-detect" title="Re-detect table" style="font-size:9px;">🔍</button>
          <button class="kalo-btn" id="kalo-refresh" title="Refresh">🔄</button>
          <button class="kalo-btn" id="kalo-warmup-all" title="Warm up all">🔥</button>
          <button class="kalo-btn" id="kalo-download-selected" title="DL selected">📥</button>
          <button class="kalo-btn" id="kalo-download-all" title="DL all">📥◆</button>
          <button class="kalo-btn" id="kalo-close" title="Close">✕</button>
        </div>
      </div>
      <div id="kalo-list" class="kalo-list"></div>
      <div class="kalo-log-title">📋 Log</div>
      <div id="kalo-log" class="kalo-log"></div>
    `;

    document.body.appendChild(panel);
    listContainer = document.getElementById("kalo-list");
    Logger.init(document.getElementById("kalo-log"));

    // Event Handlers
    document.getElementById("kalo-detect")?.addEventListener("click", () => {
      Logger.log("🔍 Re-detecting table structure...");
      const container = DataParser.findVideoContainer();
      if (container) {
        const rows = Array.from(container.querySelectorAll("tr[data-row-key], tbody tr, [role='row']"));
        Logger.log(`✅ Found container with ${rows.length} rows`);
        UIManager.render();
      } else {
        Logger.log("❌ Could not find Video & Quảng cáo table. Make sure you're on the right page.");
      }
    });

    document.getElementById("kalo-refresh")?.addEventListener("click", () => {
      UIManager.render();
      Logger.log("🔄 Data refreshed");
    });

    document.getElementById("kalo-warmup-all")?.addEventListener("click", () => {
      DownloadManager.warmUpBatch(currentItems);
    });

    document.getElementById("kalo-download-selected")?.addEventListener("click", () => {
      const selected = currentItems.filter(item => selectedIds.has(item.id));
      if (selected.length === 0) {
        Logger.log("⚠️ Select at least one video");
        return;
      }
      DownloadManager.downloadBatch(selected, "selected");
    });

    document.getElementById("kalo-download-all")?.addEventListener("click", () => {
      if (currentItems.length === 0) {
        Logger.log("⚠️ No videos available");
        return;
      }
      DownloadManager.downloadBatch(currentItems, "all");
    });

    document.getElementById("kalo-close")?.addEventListener("click", () => {
      panel.classList.add("hidden");
      Logger.log("Panel closed");
    });

    // Launcher Button
    const launcher = document.createElement("button");
    launcher.id = "kalo-launcher";
    launcher.title = "Toggle Downloader";
    launcher.innerHTML = `
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M12 3v10m0 0l3.5-3.5M12 13l-3.5-3.5M5 15v3a1 1 0 001 1h12a1 1 0 001-1v-3"/>
      </svg>
    `;
    launcher.addEventListener("click", () => {
      panel.classList.toggle("hidden");
      if (!panel.classList.contains("hidden")) {
        Logger.log("🔍 Searching for Video & Quảng cáo table...");
        UIManager.render();
      }
    });
    document.body.appendChild(launcher);

    // Styles
    const style = document.createElement("style");
    style.textContent = STYLES;
    document.head.appendChild(style);

    // Initial State
    panel.classList.add("hidden");

    // Global API
    window.__kaloConsole = {
      remove: () => {
        panel?.remove?.();
        launcher?.remove?.();
        style?.remove?.();
        if (observerHandle) {
          observerHandle.disconnect();
          observerHandle = null;
        }
        if (observerDebounceTimer) {
          clearTimeout(observerDebounceTimer);
        }
        observedContainer = null;
        logBox = null;
      }
    };

    // Initial Render
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", () => {
        Logger.log("⏳ Initializing extension...");
        Logger.log("💡 Hint: Make sure 'Video & Quảng cáo' table is visible");
        Logger.log("💡 If no data shows, click 🔍 button to re-detect table");
        UIManager.render();
        Logger.log("✅ Extension Ready");
      });
    } else {
      Logger.log("⏳ Initializing extension...");
      Logger.log("💡 Hint: Make sure 'Video & Quảng cáo' table is visible");
      Logger.log("💡 If no data shows, click 🔍 button to re-detect table");
      UIManager.render();
      Logger.log("✅ Extension Ready");
    }

    // No global body observer and no interval auto-refresh to avoid slowing the page.
  }

  // Initialize when DOM is ready
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initializePanel);
  } else {
    initializePanel();
  }
})();
