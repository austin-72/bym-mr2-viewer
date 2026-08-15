import { ApiClient } from "./api-client.js";
import { openBaseView } from "./base-view.js";
import { AssetCache } from "./asset-cache.js";
import { MapRenderer } from "./map-renderer.js";
import {
  ASSET_PATHS,
  cellKey,
  SEARCH_RESULT_LIMIT,
  STABLE_VIEWER_CONFIG,
  buildTokenStorageKey,
  storageGet,
  storageSet,
  storageRemove,
  KIT_FILTER_OPTIONS,
  HEIGHT_FILTER_OPTIONS,
  OWNER_FILTER_OPTIONS,
  TRIBE_FILTER_OPTIONS,
  PROTECTION_FILTER_OPTIONS,
  ALL_PROTECTION_FILTER_KEYS,
  ALL_TYPE_FILTER_KEYS,
  ALL_KIT_FILTER_KEYS,
  ALL_HEIGHT_FILTER_KEYS,
  ALL_OWNER_FILTER_KEYS,
  ALL_TRIBE_FILTER_KEYS,
  TYPE_FILTER_OPTIONS,
  createEmptyBaseFilter,
  getOutpostKitKey,
  describeOutpostKitLabel,
  getOutpostKitSuffix,
  describeTribe,
  getTribeKey,
  describeYardType,
  escapeHtml,
  fetchAdminStatus,
  setViewerAuthToken,
  fetchAnnouncement,
  buildBymUrl,
  fetchBaseData,
  fetchHiddenPlayers,
  fetchJson,
  sanitizeErrorMessage,
  fetchLeaderboardHistory,
  getCellLootTotal,
  formatRelativeTime,
  storageGetUserSettings,
  storageListServers,
  storageGetServerMap,
  allianceMe,
  alliancePost,
  allianceChatFetch,
  fetchWorldActivity,
  fetchWorldChanges,
  submitHideRequest,
  fetchHideRequestStatus,
  fetchPublicProfile,
  storagePostUserLogin,
  storagePutUserSettings,
  UI_PREFS_STORAGE_KEY,
  debugLog,
  formatDistance,
  formatNumber,
  getFlingerRange,
  MR2,
  getLocalViewerConfig,
  hasActiveBaseFilterState,
  setViewerConfig,
} from "./shared.js";

// Nominal coordinates shown for the Inferno yard in the base picker. It has
// no map cell of its own; -666, -666 is the placeholder the yard is listed
// under, and it can never collide with a real cell (the world is 0..799).
const INFERNO_LIST_COORD = { x: -666, y: -666 };

const MOBILE_LAYOUT_MEDIA_QUERY = "(max-width: 900px)";
const FILTER_MENU_TRANSITION_MS = 180;
const SEARCH_RESULTS_TRANSITION_MS = 180;
const DESKTOP_DETAILS_RESIZE_TRANSITION_MS = 180;
const MOBILE_DETAILS_RESIZE_TRANSITION_MS = 220;
const INITIAL_OVERLAY_MESSAGE = "Loading...";
const SIGNED_OUT_OVERLAY_MESSAGE = "Please log in.";


// Lowest proxy band: background crawls must never outrank interactive use.
const FETCH_PRIORITY_BACKGROUND = 1;
// Operator-initiated scans (Scan World / Scan Bases) run at top priority.
const BASE_SCAN_PRIORITY = 10;

export class ViewerApp {
  constructor() {
    this.api = null;
    this.assets = null;
    this.config = null;
    this.localConfig = null;
    this.session = null;
    this.worlds = [];
    this.worldNameById = new Map();
    this.leaderboardCache = new Map();
    this.leaderboardRequests = new Map();
    this.selectedWorldId = null;
    this.hoveredCell = null;
    this.selectedCell = null;
    this.playerBaseIconUrl = "";
    this.searchEntries = [];
    this.searchMatches = [];
    this.searchActiveIndex = -1;
    this.playerFilterEntries = [];
    this.playerFilterMatches = [];
    this.playerFilterActiveIndex = -1;
    this.filterState = createEmptyBaseFilter();
    this.availableFilterLevels = [];
    this.availableOutpostMax = 0;
    this.ownerOutpostCounts = new Map();
    this.openMenuId = null;
    // The .tb-item owning the open menu. Held explicitly because the menu is
    // re-homed to the toolbar element while open (see portalFloatingMenu), so
    // menu.closest(".tb-item") stops working the moment the menu is open.
    this.openMenuItem = null;
    this.showLoot = false;
    // Separate from showLoot: this one governs the cell popup's loot rows.
    this.showLootInfo = false;
    this.lootResource = "total";
    this.isGuestView = false;
    this.guestAttemptId = 0;
    this.cachedServers = new Map();
    this.viewedWorldId = null;
    this.alliance = null;
    this.allianceInvites = [];
    this.allianceMemberNames = new Set();
    this.allianceEnemyNames = new Set();
    this.allianceChat = [];
    this.allianceChatLatest = 0;
    this.alliancePollTimer = 0;
    this.alliancePollTick = 0;
    this.alliancePanelSignature = null;
    this.allianceActiveTab = "chat";
    this.allianceMemberMeta = new Map();
    this.allianceUnreadChat = 0;
    this.profilePicCache = new Map();
    this.isViewerAdmin = false;
    this.hiddenPlayerNames = new Set();
    this.rawHiddenPlayerNames = new Set();
    this.filterMenuOpen = false;
    this.tokenRecoveryPromise = null;
    this.isMobileLayout = false;
    this.mobileSearchOpen = false;
    this.mobileLayoutMediaQuery = window.matchMedia(MOBILE_LAYOUT_MEDIA_QUERY);
    this.filterMenuCloseTimer = 0;
    this.searchResultsUi = {
      map: {
        closeTimer: 0,
        resizeFrame: 0,
        resizeTimer: 0,
      },
      filterPlayer: {
        closeTimer: 0,
        resizeFrame: 0,
        resizeTimer: 0,
      },
    };
    this.desktopDetailsResizeFrame = 0;
    this.desktopDetailsResizeTimer = 0;
    this.mobileDetailsResizeFrame = 0;
    this.mobileDetailsResizeTimer = 0;
    this.bookmarks = [];
    // Per-user settings blob mirrored to users/{username}/settings.json on
    // the viewer server. Loaded right after sign-in, saved debounced.
    this.userSettings = null;
    this.userSettingsSaveTimer = 0;
    this.profileOwnerId = null;
    this.measureActive = false;
    this.scanRunning = false;
    this.watchTimer = 0;
    this.watchOwnTimer = 0;
    this.keepaliveTimer = 0;
    this.activityTab = "me";
    // Global tab feed: fetched cross-world from the viewer server, cached
    // briefly so tab-hopping does not hammer the endpoint.
    this.globalActivity = { records: [], fetchedAt: 0, loading: false };
    // Wall-clock time of the last successful authenticated exchange; the
    // keepalive only spends a getinfo once the token has sat idle past
    // MR2.sessionKeepaliveIdleMs.
    this.lastTokenTouchAt = 0;
    this.watchCycleInFlight = false;
    this.watchEvents = this.createEmptyWatchEvents();
    this.pendingUrlJump = null;

    this.elements = {
      appRoot: document.getElementById("app"),
      mapSearchPanel: document.querySelector(".map-search-panel"),
      sessionPanel: document.querySelector(".session-panel"),
      emailInput: document.getElementById("email-input"),
      passwordInput: document.getElementById("password-input"),
      loginForm: document.getElementById("login-form"),
      attachTokenInput: document.getElementById("attach-token-input"),
      attachTokenButton: document.getElementById("attach-token-button"),
      tokenCopyScriptButton: document.getElementById("token-copy-script-button"),
      loginButton: document.getElementById("login-button"),
      logoutButton: document.getElementById("logout-button"),
      sessionName: document.getElementById("session-name"),
      sessionSignedIn: document.getElementById("session-signed-in"),
      sessionNameDisplay: document.getElementById("session-name-display"),
      accountButton: document.getElementById("account-button"),
      sessionStatus: document.getElementById("session-status"),
      worldName: document.getElementById("world-name"),
      worldList: document.getElementById("world-list"),
      leaderboardTitle: document.getElementById("leaderboard-title"),
      leaderboardList: document.getElementById("leaderboard-list"),
      detailsPanel: document.querySelector(".details-panel"),
      detailsTitle: document.getElementById("details-title"),
      detailsContent: document.getElementById("details-content"),
      mobileDetailsSheet: document.getElementById("mobile-details-sheet"),
      mobileDetailsTitle: document.getElementById("mobile-details-title"),
      mobileDetailsContent: document.getElementById("mobile-details-content"),
      mobileDetailsCloseButton: document.getElementById("mobile-details-close-button"),
      detailsCloseButton: document.getElementById("details-close-button"),
      mapCanvas: document.getElementById("map-canvas"),
      mapCoordinates: document.getElementById("map-coordinates"),
      mapOverlay: document.getElementById("map-overlay"),
      searchToggleButton: document.getElementById("search-toggle-button"),
      searchInput: document.getElementById("search-input"),
      searchResults: document.getElementById("search-results"),
      searchStatus: document.getElementById("search-status"),
      filterAnchor: document.querySelector(".map-filter-anchor"),
      filterToggleButton: document.getElementById("filter-toggle-button"),
      filterToggleLabel: document.getElementById("filter-toggle-label"),
      filterStatus: document.getElementById("filter-status"),
      filterMenu: document.getElementById("filter-menu"),
      filterClearButton: document.getElementById("filter-clear-button"),
      filterInactivityEnabled: document.getElementById("filter-inactivity-enabled"),
      filterInactivityDays: document.getElementById("filter-inactivity-days"),
      filterInactivityLabel: document.getElementById("filter-inactivity-label"),
      helpButton: document.getElementById("help-button"),
      helpPanel: document.getElementById("help-panel"),
      helpClose: document.getElementById("help-close"),
      hideRequestForm: document.getElementById("hide-request-form"),
      hideRequestStatus: document.getElementById("hide-request-status"),
      hideRequestReason: document.getElementById("hide-request-reason"),
      hideRequestSubmit: document.getElementById("hide-request-submit"),
      filterPlayerInput: document.getElementById("filter-player-input"),
      filterPlayerResults: document.getElementById("filter-player-results"),
      filterTypeOptions: document.getElementById("filter-type-options"),
      filterKitOptions: document.getElementById("filter-kit-options"),
      filterHeightOptions: document.getElementById("filter-height-options"),
      filterOwnerOptions: document.getElementById("filter-owner-options"),
      filterTribeOptions: document.getElementById("filter-tribe-options"),
      filterFlingerEnabled: document.getElementById("filter-flinger-enabled"),
      filterFlingerOptions: document.getElementById("filter-flinger-options"),
      filterDamageMinInput: document.getElementById("filter-damage-min-input"),
      filterDamageMaxInput: document.getElementById("filter-damage-max-input"),
      filterDamageMinLabel: document.getElementById("filter-damage-min-label"),
      filterDamageMaxLabel: document.getElementById("filter-damage-max-label"),
      filterDamageFill: document.getElementById("filter-damage-range-fill"),
      filterProtectionYes: document.getElementById("filter-protection-yes"),
      filterProtectionNo: document.getElementById("filter-protection-no"),
      filterPlayerList: document.getElementById("filter-player-list"),
      filterLevelRange: document.getElementById("filter-level-range"),
      filterLevelMinInput: document.getElementById("filter-level-min-input"),
      filterLevelMaxInput: document.getElementById("filter-level-max-input"),
      filterLevelMinLabel: document.getElementById("filter-level-min-label"),
      filterLevelMaxLabel: document.getElementById("filter-level-max-label"),
      filterLevelRangeFill: document.getElementById("filter-level-range-fill"),
      filterLevelHelp: document.getElementById("filter-level-help"),
      filterOutpostRange: document.getElementById("filter-outpost-range"),
      filterOutpostInput: document.getElementById("filter-outpost-input"),
      filterOutpostMaxInput: document.getElementById("filter-outpost-max-input"),
      filterOutpostLabel: document.getElementById("filter-outpost-label"),
      filterOutpostMaxLabel: document.getElementById("filter-outpost-max-label"),
      filterOutpostRangeFill: document.getElementById("filter-outpost-range-fill"),
      filterOutpostHelp: document.getElementById("filter-outpost-help"),
      lootItem: document.getElementById("loot-item"),
      lootShowToggle: document.getElementById("loot-show-toggle"),
      lootInfoToggle: document.getElementById("loot-info-toggle"),
      allianceItem: document.getElementById("alliance-item"),
      allianceBadge: document.getElementById("alliance-badge"),
      scanItem: document.getElementById("scan-item"),
      setupItem: document.getElementById("setup-item"),
      setupButton: document.getElementById("setup-button"),
      allianceContent: document.getElementById("alliance-content"),
      toolbar: document.getElementById("toolbar"),
      filterMatchCount: document.getElementById("filter-match-count"),
      findHomeButton: document.getElementById("find-home-button"),
      toolsPanel: document.getElementById("tools-panel"),
      toolsMinimize: document.getElementById("tools-minimize"),
      toolsRestore: document.getElementById("tools-restore"),
      jumpXInput: document.getElementById("jump-x-input"),
      jumpYInput: document.getElementById("jump-y-input"),
      jumpButton: document.getElementById("jump-button"),
      jumpOpenButton: document.getElementById("jump-open-button"),
      jumpModal: document.getElementById("jump-modal"),
      jumpModalClose: document.getElementById("jump-modal-close"),
      bookmarksToggleButton: document.getElementById("bookmarks-toggle-button"),
      bookmarkFlyout: document.getElementById("bookmark-flyout"),
      bookmarkAddModal: document.getElementById("bookmark-add-modal"),
      bookmarkAddClose: document.getElementById("bookmark-add-close"),
      modalBlocker: document.getElementById("mr2-modal-blocker"),
      searchModal: document.getElementById("search-modal"),
      searchModalClose: document.getElementById("search-modal-close"),
      worldsModal: document.getElementById("worlds-modal"),
      worldsModalClose: document.getElementById("worlds-modal-close"),
      accountModal: document.getElementById("account-modal"),
      exportModal: document.getElementById("export-modal"),
      accountModalClose: document.getElementById("account-modal-close"),
      worldOpenButton: document.getElementById("world-open-button"),
      zoomSliderIn: document.getElementById("zoom-slider-in"),
      zoomSliderOut: document.getElementById("zoom-slider-out"),
      zoomSliderTrack: document.getElementById("zoom-slider-track"),
      zoomSliderThumb: document.getElementById("zoom-slider-thumb"),
      bookmarkNameInput: document.getElementById("bookmark-name-input"),
      bookmarkAddButton: document.getElementById("bookmark-add-button"),

      measureButton: document.getElementById("measure-button"),
      measureStatus: document.getElementById("measure-status"),
      scanButton: document.getElementById("scan-button"),
      scanProgress: document.getElementById("scan-progress"),
      scanProgressFill: document.getElementById("scan-progress-fill"),
      scanStatus: document.getElementById("scan-status"),
      watchRefreshToggle: document.getElementById("watch-refresh-toggle"),
      activityList: document.getElementById("activity-list"),
      activityStatus: document.getElementById("activity-status"),
    };
  }

  // ------------------------------------------------------------------
  // ------------------------------------------------------------------
  async start() {
    try {
      const params = new URLSearchParams(window.location.search);
      const urlX = Number.parseInt(params.get("x") ?? "", 10);
      const urlY = Number.parseInt(params.get("y") ?? "", 10);
      if (Number.isFinite(urlX) && Number.isFinite(urlY)) {
        this.pendingUrlJump = {
          x: urlX,
          y: urlY,
          world: String(params.get("world") || "").trim(),
        };
        debugLog("URL requests a jump to", this.pendingUrlJump);
      }
    } catch (error) {
      void error;
    }

    this.localConfig = getLocalViewerConfig();
    this.bindEvents();
    this.syncResponsiveLayout(this.mobileLayoutMediaQuery.matches);
    await this.connectToServer({ restoreSession: true });
  }

  bindEvents() {
    this.elements.loginForm.addEventListener("submit", (event) => this.handleLogin(event));
    this.elements.attachTokenButton?.addEventListener("click", () => this.handleAttachToken());
    this.elements.tokenCopyScriptButton?.addEventListener("click", () => this.copyTokenScript());
    for (const tab of document.querySelectorAll("[data-login-mode]")) {
      tab.addEventListener("click", () => this.setLoginMode(tab.dataset.loginMode));
    }
    this.elements.logoutButton.addEventListener("click", () => this.handleLogout());
    this.elements.findHomeButton.addEventListener("click", () => {
      if (!this.session || this.isGuestView) {
        this.openAccountModal();
        return;
      }
      this.renderer.focusHome();
    });
    // The tools popup minimizes to a "+" chip at the top-left of the map
    // (under the announcement strip) and reopens from it; the choice
    // sticks across visits.
    const setToolsMinimized = (min) => {
      if (!min) this.closeAllDockPanels?.();
      if (this.elements.toolsPanel) this.elements.toolsPanel.hidden = min;
      // The bar stays put as the anchor; the panel floats beside the
      // dock, so nothing in the column shifts.
      // The bar is permanent now - older markup/state may still carry
      // hidden, so clear it defensively.
      if (this.elements.toolsRestore) this.elements.toolsRestore.hidden = false;
      this.elements.toolsRestore?.classList.toggle("active", !min);
      this.updateTopStripVisibility();
      try { localStorage.setItem("mr2:toolsMinimized", min ? "1" : "0"); }
      catch { /* private mode: the popup just won't remember */ }
    };
    this.setToolsMinimized = setToolsMinimized;
    this.elements.toolsMinimize?.addEventListener("click", () => setToolsMinimized(true));
    this.elements.toolsRestore?.addEventListener("click", () => {
      setToolsMinimized(!this.elements.toolsPanel?.hidden);
    });
    try {
      setToolsMinimized(localStorage.getItem("mr2:toolsMinimized") !== "0");
    } catch { setToolsMinimized(true); }
    this.elements.mobileDetailsCloseButton.addEventListener("click", () => this.handleMobileDetailsClose());
    this.elements.detailsCloseButton?.addEventListener("click", () => this.closeCellDetails());
    // MapRoomPopup 1:1: Jump opens a blocking modal at a fixed spot;
    // Bookmarks toggles the plate-row flyout; adding happens from a
    // cell's Bookmark button through the PopupNewBookmark-style modal.
    this.elements.jumpOpenButton?.addEventListener("click", () => this.openJumpModal());
    this.elements.jumpModalClose?.addEventListener("click", () => this.closeModals());
    this.elements.bookmarkAddClose?.addEventListener("click", () => this.closeModals());
    this.elements.searchModalClose?.addEventListener("click", () => this.closeModals());
    this.elements.worldOpenButton?.addEventListener("click", () => this.openWorldsModal());
    this.elements.worldsModalClose?.addEventListener("click", () => {
      // Backing out of the guest server pick returns to sign-in.
      const backToSignIn = this.worldsModalFromGuest
        && !this.session && !this.viewedWorldId;
      this.closeModals();
      if (backToSignIn) this.openAccountModal();
    });
    this.elements.accountButton?.addEventListener("click", () => this.openAccountModal());
    this.elements.accountModalClose?.addEventListener("click", () => this.closeModals());
    document.getElementById("outpost-type-toggle")?.addEventListener("change", (event) => {
      this.showOutpostTypes = Boolean(event.target.checked);
      this.saveUiPref("showOutpostTypes", this.showOutpostTypes);
      this.renderer?.setShowOutpostTypes(this.showOutpostTypes);
    });
    document.getElementById("idle-worker-toggle")?.addEventListener("change", (event) => {
      this.showIdleWorkers = Boolean(event.target.checked);
      this.saveUiPref("showIdleWorkers", this.showIdleWorkers);
      this.renderer?.setShowIdleWorkers(this.showIdleWorkers);
    });
    document.getElementById("battlelogs-close")?.addEventListener("click", () => this.closeModals());
    document.getElementById("export-open-button")?.addEventListener("click", () => this.openExportModal());
    document.getElementById("export-modal-close")?.addEventListener("click", () => this.closeModals());
    document.getElementById("export-cancel-button")?.addEventListener("click", () => this.closeModals());
    document.getElementById("export-go-button")?.addEventListener("click", () => this.runExport());
    for (const radio of document.querySelectorAll("input[name='export-type']")) {
      radio.addEventListener("change", () => this.syncExportModal());
    }
    for (const el of document.querySelectorAll("input[name='export-scope']")) {
      el.addEventListener("change", () => this.updateExportCount());
    }
    document.getElementById("export-select-cancel")?.addEventListener("click", () => this.endRegionSelect());
    document.getElementById("export-select-go")?.addEventListener("click", () => this.finishRegionExport());
    for (const guestBtn of document.querySelectorAll(".account-guest-btn")) {
      guestBtn.addEventListener("click", () => {
        this.bootChoiceMade = true;
        this.worldsModalFromGuest = true;
        this.closeModals();
        this.openWorldsModal();
      });
    }
    this.setupZoomSlider();
    this.setupDock();
    this.setupAssetRetry();
    this.setupCssAssetRetry();
    this.elements.bookmarksToggleButton?.addEventListener("click", () => this.toggleBookmarkFlyout());
    this.elements.jumpButton.addEventListener("click", () => this.handleJump());
    const jumpOnEnter = (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        this.handleJump();
      }
    };
    this.elements.jumpXInput.addEventListener("keydown", jumpOnEnter);
    this.elements.jumpYInput.addEventListener("keydown", jumpOnEnter);
    this.elements.bookmarkAddButton.addEventListener("click", () => this.handleAddBookmark());
    this.elements.bookmarkNameInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        this.handleAddBookmark();
      }
    });
    this.elements.measureButton.addEventListener("click", () => this.toggleMeasure());
    this.elements.scanButton.addEventListener("click", () => this.handleScanButton());
    document.getElementById("scan-bases-button")?.addEventListener("click", () => this.handleScanBasesButton());
    this.elements.watchRefreshToggle.addEventListener("change", () => this.handleWatchToggle());
    for (const tab of document.querySelectorAll("[data-activity-tab]")) {
      tab.addEventListener("click", () => this.setActivityTab(tab.dataset.activityTab));
    }
    this.elements.searchToggleButton.addEventListener("click", () => this.handleSearchToggle());
    this.bindToolbarMenus();
    this.elements.lootShowToggle?.addEventListener("change", (event) => {
      this.toggleLootDisplay(event.target.checked);
    });
    this.elements.lootInfoToggle?.addEventListener("change", (event) => {
      this.toggleLootInfo(event.target.checked);
    });
    for (const radio of document.querySelectorAll("input[name='loot-resource']")) {
      radio.addEventListener("change", (event) => {
        if (event.target.checked) {
          this.setLootResource(event.target.value);
        }
      });
    }
    this.elements.searchInput.addEventListener("input", () => this.handleSearchInput());
    this.elements.searchInput.addEventListener("keydown", (event) => this.handleSearchKeyDown(event));
    this.elements.searchInput.addEventListener("focus", () => this.renderSearchResults());
    this.elements.searchInput.addEventListener("click", () => this.handleSearchInputTap());
    this.elements.searchInput.addEventListener("blur", () => {
      window.setTimeout(() => {
        if (this.isMobileLayout && this.mobileSearchOpen) {
          this.renderSearchResults();
          return;
        }
        this.hideSearchResults();
      }, 120);
    });
    this.elements.filterToggleButton.addEventListener("click", () => this.handleFilterToggle());
    this.elements.filterClearButton.addEventListener("click", () => this.clearFilters());
    this.elements.filterInactivityEnabled?.addEventListener("change", () => this.syncInactivityFilter());
    this.elements.filterInactivityDays?.addEventListener("input", () => this.syncInactivityFilter());
    this.elements.helpButton?.addEventListener("click", () => this.openHelpPanel());
    this.elements.helpClose?.addEventListener("click", () => {
      this.elements.helpPanel.hidden = true;
    });
    this.elements.helpPanel?.addEventListener("click", (event) => {
      if (event.target === this.elements.helpPanel) {
        this.elements.helpPanel.hidden = true;
      }
    });
    this.elements.setupButton?.addEventListener("click", () => {
      window.location.href = "/setup/";
    });
    this.elements.hideRequestSubmit?.addEventListener("click", () => this.submitHideRequest());
    this.elements.filterPlayerInput.addEventListener("input", () => this.handlePlayerFilterInput());
    this.elements.filterPlayerInput.addEventListener("keydown", (event) => this.handlePlayerFilterKeyDown(event));
    this.elements.filterPlayerInput.addEventListener("focus", () => this.handlePlayerFilterFocus());
    this.elements.filterPlayerInput.addEventListener("click", () => this.handlePlayerFilterInputTap());
    this.elements.filterPlayerInput.addEventListener("blur", () => {
      window.setTimeout(() => {
        if (this.isMobileLayout && this.filterMenuOpen) {
          this.renderPlayerFilterResults();
          return;
        }
        this.hidePlayerFilterResults();
      }, 120);
    });
    this.elements.filterTypeOptions.addEventListener("change", (event) => this.handleFilterOptionChange(event));
    this.elements.filterKitOptions.addEventListener("change", (event) => this.handleFilterOptionChange(event));
    this.elements.filterHeightOptions?.addEventListener("change", (event) => this.handleFilterOptionChange(event));
    this.elements.filterOwnerOptions?.addEventListener("change", (event) => this.handleFilterOptionChange(event));
    this.elements.filterTribeOptions?.addEventListener("change", (event) => this.handleFilterOptionChange(event));
    this.elements.filterFlingerOptions?.addEventListener("change", (event) => this.handleFilterOptionChange(event));
    this.elements.filterFlingerEnabled?.addEventListener("change", () => {
      this.filterState = {
        ...this.filterState,
        flingerEnabled: Boolean(this.elements.filterFlingerEnabled.checked),
      };
      this.renderFilterOptions();
      this.applyFilters();
    });
    this.elements.filterDamageMinInput?.addEventListener("input", () => this.handleDamageRangeInput());
    this.elements.filterDamageMaxInput?.addEventListener("input", () => this.handleDamageRangeInput());
    const onProtectionChange = () => {
      const chosen = [];
      if (this.elements.filterProtectionYes?.checked) chosen.push("protected");
      if (this.elements.filterProtectionNo?.checked) chosen.push("unprotected");
      this.filterState = { ...this.filterState, protection: chosen };
      this.renderFilterOptions();
      this.applyFilters();
    };
    this.elements.filterProtectionYes?.addEventListener("change", onProtectionChange);
    this.elements.filterProtectionNo?.addEventListener("change", onProtectionChange);
    document.querySelectorAll("[data-card-reset]").forEach((button) => {
      button.addEventListener("click", () => this.resetFilterCard(button.dataset.cardReset));
    });
    this.elements.filterLevelMinInput?.addEventListener("input", (event) => this.handleLevelRangeInput(event));
    this.elements.filterLevelMaxInput?.addEventListener("input", (event) => this.handleLevelRangeInput(event));
    this.elements.filterOutpostInput?.addEventListener("input", (event) => this.handleOutpostFilterInput(event));
    this.elements.filterOutpostMaxInput?.addEventListener("input", (event) => this.handleOutpostFilterInput(event));
    document.addEventListener("pointerdown", (event) => this.handleGlobalPointerDown(event));
    const closeFloatingMenus = () => {
      this.closeToolbarMenus();
      if (this.filterMenuOpen) {
        this.setFilterMenuOpen(false);
      }
    };
    document.querySelector(".toolbar-scroll")?.addEventListener("scroll", () => {
      // A finger scrolling the strip should dismiss anchored dropdowns, but
      // only on desktop. On the phone layout the menus are full-width sheets
      // that don't track a button, and Android Chrome scrolls this container
      // by itself (focus scroll-into-view, scroll-snap settling) - which was
      // closing sheets the instant they opened.
      if (this.isMobileLayout) {
        return;
      }
      closeFloatingMenus();
    }, { passive: true });
    // The on-screen keyboard reports as a height-only window resize on
    // Android Chrome. Closing menus on any resize made sign-in impossible
    // there: the account menu (and its login form) vanished the moment the
    // email field took focus. Height-only changes now re-clamp the open
    // dropdown in place; only a real width change (desktop window resize)
    // still dismisses it.
    let lastViewportWidth = window.innerWidth;
    window.addEventListener("resize", () => {
      const width = window.innerWidth;
      const widthChanged = width !== lastViewportWidth;
      lastViewportWidth = width;
      if (!widthChanged || this.isMobileLayout) {
        this.repositionOpenFloatingMenus();
        return;
      }
      closeFloatingMenus();
    });
    document.addEventListener("keydown", (event) => this.handleGlobalKeyDown(event));

    const handleLayoutChange = (event) => this.syncResponsiveLayout(event.matches);
    if (typeof this.mobileLayoutMediaQuery.addEventListener === "function") {
      this.mobileLayoutMediaQuery.addEventListener("change", handleLayoutChange);
    } else if (typeof this.mobileLayoutMediaQuery.addListener === "function") {
      this.mobileLayoutMediaQuery.addListener(handleLayoutChange);
    }
  }

  // The viewer connects to a single fixed BYM server. Which in-game world
  // the player is on is not chosen here; it is whatever world their account
  // is currently in, reported by the server after sign-in (its 0x0-style
  // world id / name).
  async connectToServer({ restoreSession }) {
    const baseConfig = STABLE_VIEWER_CONFIG;
    const discoveryClient = new ApiClient(baseConfig);
    const resolvedApiVersion = await discoveryClient.resolveApiVersion();
    this.config = setViewerConfig({
      ...baseConfig,
      apiVersion: resolvedApiVersion,
    });
    this.api = new ApiClient(this.config);
    this.assets = new AssetCache(this.config);
    // A late-arriving asset (one that 502'd during preload and was retried)
    // has to trigger a redraw, or the map keeps its fallback until the next
    // pan or zoom.
    this.assets.onAssetLoaded = () => this.renderer?.render?.();
    this.playerBaseIconUrl = this.assets.urlFor(ASSET_PATHS.playerBase);
    this.updateFavicon();

    this.setSessionStatus("Connecting to the BYM server...");
    this.setSearchEnabled(false, "Loading CDN assets...");
    this.setFilterEnabled(false);
    this.session = null;
    this.worlds = [];
    this.worldNameById = new Map();
    this.leaderboardCache = new Map();
    this.leaderboardRequests = new Map();
    this.selectedWorldId = null;
    this.hoveredCell = null;
    this.selectedCell = null;
    this.renderWorldList();
    this.elements.leaderboardTitle.textContent = "No world selected";
    this.elements.leaderboardList.textContent = "";
    this.renderDetails();

    this.setSessionStatus("Loading CDN assets...");
    await this.assets.preload();

    if (!this.renderer) {
      this.renderer = new MapRenderer({
        canvas: this.elements.mapCanvas,
        overlayEl: this.elements.mapOverlay,
        coordsEl: this.elements.mapCoordinates,
        statusEl: null,
        assets: this.assets,
        api: this.api,
        onHoverCell: (cell) => this.handleHoveredCell(cell),
        onSelectCell: (cell) => this.handleSelectedCell(cell),
      });
      this.renderer.onCacheHydrated = () => this.handleCacheHydrated();
      this.renderer.onTokenRefresh = (token) => this.adoptRefreshedToken(token);
      // Assigned here, not in establishSession: guest views (no sign-in)
      // can measure too, and ownership-change recording must be armed
      // before the first bootstrap ever runs.
      this.renderer.onCellOwnershipChanges = (changes) => this.recordWatchEvents(changes);
      this.renderer.onZoneLoaded = (cells) => this.handleZoneLoaded(cells);
      this.renderer.onMeasureUpdated = (state) => this.updateMeasureStatus(state);
      // Let the API client recover from a rotated/expired session on its own.
      this.api.getCurrentToken = () => this.session?.token || "";
      this.api.refreshSession = () => this.recoverSessionToken();
      this.api.onAuthExpired = () => this.handleSessionExpired();
    } else {
      this.renderer.api = this.api;
      this.renderer.assets = this.assets;
    }

    this.setPendingSessionState();
    // Moderation state (hidden players + announcement) loads for EVERYONE,
    // guests included - it only ran inside establishSession before, which
    // left every hiding surface (map disguise, search, leaderboard...)
    // inert in guest mode. Signing in re-runs it with the session token.
    const moderationPromise = this.loadModerationState().catch(() => {});
    // Worlds + leaderboards are toolbar niceties; a failure there must not
    // reject connectToServer and take the sign-in flow and map down with it.
    const worldsPromise = this.loadWorlds().catch((error) => {
      console.error("[BYM-MR2] Failed to load the world list:", error);
      this.worlds = [];
      this.renderWorldList();
      this.elements.leaderboardTitle.textContent = "Worlds unavailable";
      this.elements.leaderboardList.textContent =
        error?.message || "Failed to load the world list from the BYM server.";
    });

    if (restoreSession) {
      await this.restoreSession();
    } else {
      this.setSignedOutState();
    }

    await worldsPromise;
    await moderationPromise;
    this.renderer.render();
  }

  updateFavicon() {
    const favicon = document.getElementById("app-favicon");
    if (!favicon || favicon.tagName !== "LINK") {
      return;
    }

    favicon.href = `${this.config.cdnBaseUrl}/assets/buildings/maproom/top.1.png`;
  }

  async restoreSession() {
    const storedToken = storageGet(buildTokenStorageKey(this.config));
    if (!storedToken) {
      debugLog("No stored token for this server; showing sign-in form.");
      this.setSignedOutState();
      return;
    }

    debugLog("Found stored token; attempting session refresh.");

    this.setSessionStatus("Refreshing BYM session...");

    try {
      await this.establishSession(() => this.api.refresh(storedToken), "token-refresh");
    } catch (error) {
      console.error(error);
      this.handleLogout(error.message || "Your BYM session expired.");
    }
  }

  async establishSession(loader, via = "unknown") {
    this.bootChoiceMade = true;
    // A guest signing in switches to their own world: hide every tool
    // surface until that cache hydration completes.
    this.hideDockUi?.();
    this.elements.loginButton.disabled = true;
    try {
      const session = await loader();
      debugLog("Session established:", {
        userid: session?.user?.userid,
        username: session?.user?.username,
        worldid: session?.map?.worldid,
        homebase: session?.map?.homebase,
        mapSize: `${session?.map?.width}x${session?.map?.height}`,
        outposts: session?.map?.outposts?.length ?? 0,
      });
      storageSet(buildTokenStorageKey(this.config), session.token);
      this.session = session;
      this.lastTokenTouchAt = Date.now();
      this.guestAttemptId += 1;
      this.isGuestView = false;
      this.viewedWorldId = String(session?.map?.worldid || "").trim() || null;
      // Token login and password login are identical from here on. The first
      // server-side verification calls getinfo, which rotates the game token
      // and ends the in-game session - but that happens no matter what, so
      // there is nothing to protect: the viewer verifies, adopts the rotated
      // token, and cycles it normally (keepalive + recovery) to stay alive.
      setViewerAuthToken(session.token || "");
      await this.loadModerationState();
      await this.loadUserSettings(session.user.username);
      this.elements.loginForm.hidden = true;
      this.elements.sessionPanel.classList.add("signed-in");
      this.elements.sessionSignedIn.hidden = false;
      this.elements.sessionNameDisplay.textContent = session.user.username || "Signed in";
      this.elements.accountButton.hidden = true;
      this.closeModals();
      this.closeToolbarMenus();
      this.sessionMapMeta = session.map || null;
      this.updateWorldNameDisplay();
      try {
        window.localStorage.setItem("bymViewerLastUser", session.user?.username || "");
      } catch (error) {
        void error;
      }
      this.recordLoginTime(via);
      this.startAlliance();
      this.setSessionStatus("");
      this.setSearchEnabled(false, "Loading nearby map zones...");
      this.setFilterEnabled(false);
      // Watch history must be in memory before the bootstrap refetch runs:
      // ownership changes detected while bootstrapping call recordWatchEvents,
      // which saves this.watchEvents back to storage. Loading afterwards would
      // let that save overwrite the stored history with only the new events.
      this.loadWatchEvents();
      this.applyHighlightsToRenderer();
      // A measurement session cannot survive the world being torn down and
      // rebuilt underneath it - the renderer clears its own measure state in
      // bootstrap, so the button and pill must follow.
      this.setMeasureActive(false);
      debugLog("Bootstrapping map renderer...");
      // Warm the leaderboard rows in parallel with the map bootstrap so the
      // panel opens instantly and the drift reconciler gets its first pass
      // before anyone even looks. Fire-and-forget: a slow or failed
      // leaderboard must never hold the map hostage.
      {
        const ownWorldId = String(session?.map?.worldid || "").trim();
        if (ownWorldId) {
          this.getLeaderboardRows(ownWorldId)
            .then((rows) => debugLog(`Leaderboard preloaded: ${rows.length} rows.`))
            .catch((error) => debugLog("Leaderboard preload failed.", error));
          this.startLeaderboardAutoRefresh();
        }
      }
      await this.renderer.bootstrap(session);
      debugLog("Renderer bootstrap complete; zones loaded:", this.renderer.loadedZones?.size ?? 0, "cells cached:", this.renderer.cellCache?.size ?? 0);
      this.rebuildSearchIndex();
      const hasSavedFilters = this.loadFilterState();
      this.rebuildFilterOptions(hasSavedFilters);
      this.updateFindHomeButtonState();
      this.setSearchEnabled(
        true,
        this.searchEntries.length
          ? `${formatNumber(this.searchEntries.length)} player bases indexed from explored zones.`
          : "No player bases explored yet. Pan the map to discover bases.",
      );
      this.setFilterEnabled(true);
      this.setNavEnabled(true);
      this.loadBookmarks();
      this.syncWatchTimer();
      this.renderDetails();
      this.closeToolbarMenus();

      if (this.pendingUrlJump) {
        const target = this.pendingUrlJump;
        this.pendingUrlJump = null;
        // Reuses the alliance-jump flow: same world jumps directly; another
        // world switches to its cached guest view (or errors gracefully if
        // that world has no cache) before jumping.
        this.jumpToAllianceYard({ world: target.world || "", main: { x: target.x, y: target.y } })
          .catch((error) => debugLog("URL jump failed.", error));
        debugLog("Jumping to URL target", target);
      }
    } finally {
      this.elements.loginButton.disabled = false;
    }
  }

  // The Run-box one-liner: reads flashplayer.exe's launch arguments, pulls the
  // JWT out of the &token= parameter, and copies just the token to the
  // clipboard. Kept as the single source of truth so the "Copy script" button
  // and any docs never drift apart.
  // Accepts a bare token, a "token=..." fragment, or the whole game command
  // line / loader URL, and returns just the token. The launcher token is a
  // JWT (three base64url segments split by dots); when that shape is present
  // it wins, otherwise fall back to a "token=" parameter or the trimmed input.
  extractToken(raw) {
    const value = String(raw || "").trim();
    if (!value) {
      return "";
    }
    const jwt = value.match(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);
    if (jwt) {
      return jwt[0];
    }
    const param = value.match(/token=([^&\s"']+)/i);
    if (param) {
      return param[1];
    }
    return value;
  }

  get tokenGrabberScript() {
    return "powershell -c \"[regex]::Match((Get-CimInstance Win32_Process|?{$_.Name-eq'flashplayer.exe'}).CommandLine,'token=([^&]+)').Groups[1].Value|Set-Clipboard\"";
  }

  setLoginMode(mode) {
    const next = mode === "token" ? "token" : "password";
    for (const tab of document.querySelectorAll("[data-login-mode]")) {
      const active = tab.dataset.loginMode === next;
      tab.classList.toggle("active", active);
      tab.setAttribute("aria-selected", String(active));
    }
    for (const panel of document.querySelectorAll("[data-login-panel]")) {
      panel.hidden = panel.dataset.loginPanel !== next;
    }
    this.setSessionStatus(
      next === "token"
        ? "Passwordless: hand the viewer your game's own session token."
        : "Sign in with your own BYM credentials.",
    );
  }

  async copyTokenScript() {
    const button = this.elements.tokenCopyScriptButton;
    const script = this.tokenGrabberScript;
    let copied = false;
    try {
      await navigator.clipboard.writeText(script);
      copied = true;
    } catch (error) {
      try {
        const area = document.createElement("textarea");
        area.value = script;
        area.style.position = "fixed";
        area.style.opacity = "0";
        document.body.appendChild(area);
        area.select();
        copied = document.execCommand("copy");
        area.remove();
      } catch (fallbackError) {
        console.warn("[BYM-MR2] Could not copy the token script.", fallbackError);
      }
    }
    if (button) {
      const original = "Copy script";
      button.textContent = copied ? "Copied!" : "Press Ctrl+C to copy";
      if (!copied) {
        // Last resort: surface the script so the user can select it manually.
        window.prompt("Copy this script, then run it via Windows + R:", script);
      }
      window.setTimeout(() => { button.textContent = original; }, 1800);
    }
  }

  async handleAttachToken() {
    const token = this.extractToken(this.elements.attachTokenInput?.value || "");
    if (!token) {
      this.setSessionStatus("Paste your token first (run the script, then Ctrl + V).", true);
      return;
    }

    this.setSessionStatus("Logging in with your game token...");
    try {
      await this.establishSession(() => this.api.attach(token), "token");
      this.elements.attachTokenInput.value = "";
      this.setSessionStatus(
        "Logged in with your game token. This is a full session - everything works exactly like a password sign-in.",
      );
      debugLog("Shared-token attach completed.");
    } catch (error) {
      console.error("[BYM-MR2] Shared-token attach failed:", error);
      this.setSignedOutState({
        sessionStatus: error.message || "Could not attach to that session token.",
        isError: true,
        reopenSignIn: true,
      });
    }
  }

  async handleLogin(event) {
    event.preventDefault();
    debugLog("Login form submitted.");
    const email = this.elements.emailInput.value.trim();
    const password = this.elements.passwordInput.value;

    if (!email || !password) {
      this.setSessionStatus("Email and password are required.", true);
      return;
    }

    this.setSessionStatus("Signing into BYM...");
    debugLog(`Signing in against ${this.config?.bymBaseUrl} (api ${this.config?.apiVersion}).`);

    try {
      await this.establishSession(() => this.api.login(email, password), "password");
      debugLog("Login flow completed.");
      this.elements.passwordInput.value = "";
    } catch (error) {
      console.error("[BYM-MR2] Login failed:", error);
      this.setSignedOutState({
        sessionStatus: error.message || "Authentication failed.",
        isError: true,
        reopenSignIn: true,
      });
    }
  }

  // ------------------------------------------------------------------
  // Per-user server storage: users/{username}/settings.json holds all
  // user settings; users/{username}/logins.json accumulates UTC login
  // times. Both live on the viewer server, not in this browser.
  // ------------------------------------------------------------------
  defaultUserSettings() {
    return {
      highlights: { allies: "", enemies: "" },
      bookmarks: {},
      filters: {},
      watchEvents: {},
      allianceChatReadAt: 0,
      uiPrefs: {},
    };
  }

  async loadUserSettings(username) {
    const defaults = this.defaultUserSettings();
    const normalizedUsername = String(username || "").trim();
    if (!normalizedUsername) {
      this.userSettings = defaults;
      return;
    }

    try {
      const stored = await storageGetUserSettings(normalizedUsername);
      const source = stored && typeof stored === "object" ? stored : {};
      // The server verified (and possibly rotated) our game token; adopt the
      // one it reports as current so map requests keep authenticating.
      this.adoptRefreshedToken(source.token);
      this.userSettings = {
        highlights: { ...defaults.highlights, ...(source.highlights || {}) },
        bookmarks: { ...(source.bookmarks || {}) },
        filters: { ...(source.filters || {}) },
        // viewState is deliberately not carried over: sign-in always lands on
        // your own main yard at 1:1, so a stored camera position has nothing
        // to restore into. Any left in an existing settings blob is ignored
        // and drops out on the next save.
        watchEvents: { ...(source.watchEvents || {}) },
        allianceChatReadAt: Number(source.allianceChatReadAt || 0),
        uiPrefs: { ...(source.uiPrefs || {}) },
      };
      // Server-stored preferences win over this device's local copy, then
      // the merged result is applied to the live UI.
      try {
        const local = this.loadUiPrefs();
        const merged = { ...local, ...this.userSettings.uiPrefs };
        window.localStorage.setItem(UI_PREFS_STORAGE_KEY, JSON.stringify(merged));
        this.userSettings.uiPrefs = merged;
        this.applyUiPrefsToUi();
      } catch (error) {
        console.warn("[BYM-MR2] Failed to merge synced preferences.", error);
      }
      debugLog(`Loaded settings for ${normalizedUsername} from the viewer server.`);
    } catch (error) {
      console.warn("[BYM-MR2] Failed to load user settings from the viewer server; using defaults for this session.", error);
      this.userSettings = defaults;
    }
  }

  scheduleSaveUserSettings() {
    if (!this.session || !this.userSettings) {
      return;
    }

    if (this.userSettingsSaveTimer) {
      window.clearTimeout(this.userSettingsSaveTimer);
    }

    this.userSettingsSaveTimer = window.setTimeout(() => {
      this.userSettingsSaveTimer = 0;
      const username = String(this.session?.user?.username || "").trim();
      if (!username || !this.userSettings) {
        return;
      }

      storagePutUserSettings(username, this.userSettings)
        .then((result) => this.adoptRefreshedToken(result?.token))
        .catch((error) => {
          console.warn("[BYM-MR2] Failed to save user settings to the viewer server.", error);
        });
    }, 800);
  }

  getWorldSettingsKey() {
    return String(this.session?.map?.worldid || "default");
  }

  // Appends the (server-side, UTC) login time to users/{username}/logins.json.
  recordLoginTime(via) {
    const username = String(this.session?.user?.username || "").trim();
    if (!username) {
      return;
    }

    storagePostUserLogin(username, via, this.session?.user?.pic_square || "")
      .then((result) => {
        this.adoptRefreshedToken(result?.token);
        debugLog(`Login time recorded (UTC) for ${username}; total ${result?.count ?? "?"} entr${result?.count === 1 ? "y" : "ies"}.`);
      })
      .catch((error) => {
        console.warn("[BYM-MR2] Failed to record the login time.", error);
      });
  }

  handleLogout(message = "Signed out.") {
    if (this.userSettingsSaveTimer) {
      window.clearTimeout(this.userSettingsSaveTimer);
      this.userSettingsSaveTimer = 0;
    }
    this.userSettings = null;
    storageRemove(buildTokenStorageKey(this.config));
    this.session = null;
    this.setSignedOutState({ sessionStatus: message });
  }

  // The toolbar shows the world's friendly name ("<owner of 0,0> Server")
  // rather than its raw uuid. The session only reports the world id, so the
  // name is resolved against the worlds list; whichever of the two finishes
  // loading last completes the label.
  updateWorldNameDisplay() {
    if (!this.elements.worldName) {
      return;
    }

    const mapMeta = this.sessionMapMeta;
    if (!mapMeta) {
      return;
    }

    const worldId = String(mapMeta.worldid || mapMeta.worldId || "").trim();
    const rawName = (worldId && this.worldNameById && this.worldNameById.get(worldId))
      || String((this.worlds || []).find((world) => world.uuid === worldId)?.name || "").trim();

    if (rawName) {
      this.elements.worldName.textContent = /server$/i.test(rawName) ? rawName : `${rawName} Server`;
      this.elements.worldName.title = worldId;
      return;
    }

    // No friendly name yet (worlds list still loading, fetch failed, or the
    // server provides none). Prefer any name the session itself carries, but
    // never fall back to the raw world uuid as the visible label - keep it on
    // hover instead so the toolbar always reads sensibly.
    const sessionName = String(mapMeta.worldName || mapMeta.worldname || "").trim();
    this.elements.worldName.textContent = sessionName
      ? (/server$/i.test(sessionName) ? sessionName : `${sessionName} Server`)
      : "BYM World";
    this.elements.worldName.title = worldId || "";
  }

  async loadWorlds() {
    // Which worlds have cached map data decides what a guest (or a signed-in
    // user browsing another world) can view; failure is non-fatal.
    const cachedPromise = storageListServers()
      .then((servers) => {
        this.cachedServers = new Map(servers.map((entry) => [entry.name, entry]));
      })
      .catch((error) => {
        debugLog("Cached-server list unavailable.", error);
        this.cachedServers = new Map();
      });

    const worldsResponse = await this.api.getWorlds();
    const allWorlds = Array.isArray(worldsResponse.worlds) ? worldsResponse.worlds : [];
    // Resolve friendly names from EVERY world the server returns, not just the
    // MR2 subset kept below: the session's world can be filtered out of that
    // subset (e.g. a different map_version) yet still needs its toolbar name.
    this.worldNameById = new Map(
      allWorlds
        .map((world) => [String(world.uuid || "").trim(), String(world.name || "").trim()])
        .filter(([uuid, name]) => uuid && name)
    );
    this.worlds = allWorlds
      .filter((world) => Number(world.map_version) === 2)
      .sort((left, right) => Number(right.playerCount || 0) - Number(left.playerCount || 0));

    const savedWorldId = this.loadUiPrefs()[`world:${this.config?.bymBaseUrl || ""}`];
    this.selectedWorldId = this.worlds.some((world) => world.uuid === savedWorldId)
      ? savedWorldId
      : (this.worlds[0]?.uuid || null);
    await cachedPromise;
    this.renderWorldList();
    this.updateWorldNameDisplay();
    // Leaderboards now load on demand when the worlds menu opens -
    // fetching all four worlds at sign-in burned several BYM API calls
    // on data nobody may look at.
  }

  renderWorldList() {
    this.elements.worldList.replaceChildren();

    if (!this.worlds.length) {
      this.elements.worldList.textContent = "No MR2 worlds available.";
      return;
    }

    // One row per server: name, player count, and a tag - "Viewing" on
    // whatever's on screen, "Your server" on the signed-in home world
    // (Viewing REPLACES it when they're the same, per spec).
    const homeWorldId = String(this.session?.map?.worldid || "").trim() || null;
    for (const world of this.worlds) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "world-card worlds-modal-row";
      const isViewing = this.viewedWorldId === world.uuid;
      const isHome = homeWorldId && world.uuid === homeWorldId;
      if (isViewing) button.classList.add("viewing");
      if (isHome && !isViewing) button.classList.add("home");
      let tag = "";
      if (isViewing) tag = "Viewing";
      else if (isHome) tag = "Your server";
      button.innerHTML = `
        <span class="worlds-row-name">${escapeHtml(world.name || "Unnamed World")}</span>
        <span class="worlds-row-count">${formatNumber(Number(world.playerCount || 0))} players</span>
        <span class="worlds-row-tag${isViewing ? " viewing" : ""}">${escapeHtml(tag)}</span>
      `;
      button.addEventListener("click", async () => {
        this.worldsModalFromGuest = false;
        this.selectedWorldId = world.uuid;
        this.saveUiPref(`world:${this.config?.bymBaseUrl || ""}`, world.uuid);
        this.closeModals();
        this.renderWorldList();
        await this.viewWorld(world);
      });
      this.elements.worldList.appendChild(button);
    }
  }

  // The world picker also chooses which map is displayed. The signed-in
  // user's own world shows live; any other world (or any world while signed
  // out) shows its shared cache in guest mode - or a notice if no cache
  // exists for it yet.
  async viewWorld(world) {
    const uuid = String(world?.uuid || "").trim();
    if (!uuid || !this.renderer) {
      return;
    }
    // Switching servers hides every tool surface until the new cache is
    // hydrated (revealDocks re-fires from onCacheHydrated).
    this.hideDockUi();

    const sessionWorldId = String(this.session?.map?.worldid || "").trim();
    if (this.session && uuid === sessionWorldId) {
      if (this.isGuestView) {
        await this.restoreLiveWorldView();
      }
      return;
    }
    if (this.viewedWorldId === uuid && this.isGuestView) {
      return; // already showing this world's cache
    }

    // Refresh the cached-server list so a just-populated cache is seen.
    try {
      const servers = await storageListServers();
      this.cachedServers = new Map(servers.map((entry) => [entry.name, entry]));
    } catch (error) {
      void error;
    }
    if (!this.cachedServers.has(uuid)) {
      this.renderWorldList();
      this.setSessionStatus(
        `No cached map data for ${world.name || "that world"} yet - someone must explore it signed-in first.`,
        true,
      );
      return;
    }

    await this.enterGuestWorldView(uuid, world.name || "");
  }

  // Returns from a cached guest view to the signed-in user's own live world.
  async restoreLiveWorldView() {
    if (!this.session || !this.renderer) {
      return;
    }
    const attempt = ++this.guestAttemptId;
    this.isGuestView = false;
    this.viewedWorldId = String(this.session?.map?.worldid || "").trim() || null;
    this.setMeasureActive(false);

    await this.renderer.bootstrap(this.session);
    if (attempt !== this.guestAttemptId || !this.session) {
      return;
    }

    this.rebuildSearchIndex();
    this.rebuildFilterOptions(this.loadFilterState());
    this.setSearchEnabled(
      true,
      this.searchEntries.length
        ? `${formatNumber(this.searchEntries.length)} player bases indexed from explored zones.`
        : "No player bases explored yet. Pan the map to discover bases.",
    );
    this.setFilterEnabled(true);
    this.setNavEnabled(true);
    this.loadBookmarks();
    this.syncWatchTimer();
    this.updateFindHomeButtonState();
    this.updateWorldNameDisplay();
    this.renderWorldList();
    this.renderDetails();
    this.setSessionStatus("");
  }

  async loadLeaderboard(worldId) {
    const world = this.worlds.find((candidate) => candidate.uuid === worldId) || null;
    this.elements.leaderboardTitle.textContent = world ? world.name : "Selected world";
    this.elements.leaderboardList.textContent = "Loading leaderboard...";

    try {
      const rows = await this.getLeaderboardRows(worldId);
      this.elements.leaderboardList.replaceChildren();

      if (!rows.length) {
        this.elements.leaderboardList.textContent = "No leaderboard entries available.";
        return;
      }

      // History deltas ride alongside; a failure just leaves the dashes.
      let history = null;
      try {
        history = await fetchLeaderboardHistory(worldId);
      } catch (error) {
        debugLog("Leaderboard history unavailable", error);
      }
      const uidByName = new Map();
      for (const [uid, playerName] of Object.entries(history?.names || {})) {
        const lowName = String(playerName).trim().toLocaleLowerCase();
        if (lowName && !uidByName.has(lowName)) uidByName.set(lowName, uid);
      }
      const sort = this.lbSort || { key: "rank" };
      const arrow = (key) => (sort.key === key ? " \u25bc" : "");
      const header = document.createElement("div");
      header.className = "leaderboard-row leaderboard-header";
      header.innerHTML = `
        <span class="leaderboard-rank lb-sortable" data-sort="rank" title="Restore rank order">#${arrow("rank")}</span>
        <span></span>
        <span class="leaderboard-name">Username</span>
        <span class="leaderboard-count lb-sortable" data-sort="op" title="Total outposts - click to sort">OP${arrow("op")}</span>
        <span class="leaderboard-count lb-sortable" data-sort="none" title="Outposts below the Regular kit threshold (explored zones only) - click to sort">None${arrow("none")}</span>
        <span class="leaderboard-count lb-sortable" data-sort="regular" title="Regular-kit outposts (explored zones only) - click to sort">Reg${arrow("regular")}</span>
        <span class="leaderboard-count lb-sortable" data-sort="mega" title="Mega-kit outposts (explored zones only) - click to sort">Mega${arrow("mega")}</span>
        <span class="leaderboard-count lb-sortable" data-sort="ultra" title="Ultra-kit outposts (explored zones only) - click to sort">Ultra${arrow("ultra")}</span>
        <span class="leaderboard-count lb-sortable" data-sort="d7" title="Outpost change over the last 1 / 7 / 30 days - click to sort by the 7-day change">1/7/30-Day${arrow("d7")}</span>
      `;
      for (const el of header.querySelectorAll(".lb-sortable")) {
        el.addEventListener("click", () => {
          const key = el.dataset.sort;
          this.lbSort = key === "rank" ? { key: "rank" } : { key };
          this.loadLeaderboard(worldId).catch(() => {});
        });
      }
      this.elements.leaderboardList.appendChild(header);

      // Kit tiers come from the explored map cache, not the leaderboard API
      // (the server only reports totals), so an unexplored player shows
      // dashes and a partly explored one counts only what has been seen.
      const kitCounts = this.renderer ? this.renderer.getOwnerKitCounts() : new Map();

      const renderRow = (entry, rankNumber) => {
        const row = document.createElement("div");
        row.className = "leaderboard-row";
        const rank = document.createElement("strong");
        rank.className = "leaderboard-rank";
        rank.textContent = String(rankNumber);
        row.appendChild(rank);

        // Jump: resolve the player's main yard from the explored-base index
        // of the world on screen. Unexplored players can't be jumped to.
        const jump = document.createElement("button");
        jump.type = "button";
        jump.className = "game-button leaderboard-jump";
        jump.textContent = "Jump";
        const username = String(entry.username || "").trim();
        const low = username.toLocaleLowerCase();
        const hit = (this.searchEntries || []).find(
          (candidate) => candidate.normalizedUsername === low,
        );
        if (hit && this.renderer) {
          jump.title = `Jump to ${username}'s base`;
          jump.addEventListener("click", () => {
            this.renderer.focusCell(hit.cell, { animate: true, resetZoom: true });
            this.closeToolbarMenus();
          });
        } else {
          jump.disabled = true;
          jump.title = "Not explored on the current map yet";
        }
        row.appendChild(jump);

        const name = document.createElement("span");
        const nameRel = this.nameRelationClass(username);
        name.className = "leaderboard-name" + (nameRel ? " " + nameRel : "");
        name.textContent = username || "Unknown";
        name.title = username || "Unknown";
        row.appendChild(name);

        const count = document.createElement("span");
        count.className = "leaderboard-count";
        count.textContent = formatNumber(Number(entry.outpost_count || 0));
        row.appendChild(count);

        const kits = kitCounts.get(low) || null;
        for (const kitKey of ["none", "regular", "mega", "ultra"]) {
          const kitCell = document.createElement("span");
          kitCell.className = "leaderboard-count leaderboard-kit";
          if (kits) {
            kitCell.textContent = formatNumber(kits[kitKey]);
            kitCell.title = `${formatNumber(kits.total)} explored outpost${kits.total === 1 ? "" : "s"} counted`;
          } else {
            kitCell.textContent = "\u2014";
            kitCell.title = "Not explored on the current map yet";
          }
          row.appendChild(kitCell);
        }
        // Combined "+5/0/-10" delta cell, cache-vs-cache from the daily
        // snapshots. uid resolves via the explored cell first, then the
        // history's own name index (covers served-but-unexplored rows).
        const uid = String(hit?.cell?.uid || uidByName.get(low) || "");
        const deltaCell = document.createElement("span");
        deltaCell.className = "leaderboard-count leaderboard-delta";
        const baseDays = ["1", "7", "30"]
          .map((w) => history?.windows?.[w]?.baseDay || "n/a");
        deltaCell.title = `Cached outpost change over 1 / 7 / 30 days (baselines: ${baseDays.join(", ")})`;
        ["1", "7", "30"].forEach((windowKey, i) => {
          if (i) deltaCell.appendChild(document.createTextNode("/"));
          const seg = document.createElement("span");
          seg.dataset.deltaWindow = windowKey;
          const win = history?.windows?.[windowKey];
          let value = null;
          if (win && uid) {
            value = Number(win.deltas?.[uid] ?? 0);
          }
          if (value === null || !Number.isFinite(value)) {
            seg.className = "lb-delta-none";
            seg.textContent = "\u2014";
          } else if (value > 0) {
            seg.className = "lb-delta-up";
            seg.textContent = `+${formatNumber(value)}`;
          } else if (value < 0) {
            seg.className = "lb-delta-down";
            seg.textContent = `-${formatNumber(Math.abs(value))}`;
          } else {
            seg.className = "lb-delta-none";
            seg.textContent = "0";
          }
          deltaCell.appendChild(seg);
        });
        row.appendChild(deltaCell);
        this.elements.leaderboardList.appendChild(row);
      };
      // The server caps the board at 100 entries. Ranks 101-500 are
      // computed from the explored map cache (outposts counted per owner,
      // the same source as the kit columns), skipping anyone already on
      // the served board. Only explored players can appear, and the
      // divider makes the provenance explicit.
      const servedRows = rows.slice(0, 100)
        .filter((entry) => !this.isPlayerHidden(entry.username));
      const served = new Set(servedRows
        .map((e) => String(e.username || "").trim().toLocaleLowerCase()));
      const cacheCounts = this.renderer?.getOwnerOutpostCounts?.() || new Map();
      const tail = [...cacheCounts.entries()]
        .filter(([low]) => low && !served.has(low) && !this.isPlayerHidden(low))
        .sort((a, b) => b[1] - a[1])
        .slice(0, 400)
        .map(([low, outpostCount]) => {
          const hit = (this.searchEntries || []).find(
            (candidate) => candidate.normalizedUsername === low,
          );
          return {
            username: String(hit?.cell?.n || hit?.username || low),
            outpost_count: outpostCount,
          };
        });
      if (sort.key === "rank") {
        // Default: served order, then the cached range behind a divider.
        servedRows.forEach((entry, index) => renderRow(entry, index + 1));
        if (tail.length) {
          const startRank = servedRows.length + 1;
          const divider = document.createElement("div");
          divider.className = "leaderboard-divider";
          divider.textContent = `--- ${startRank} to ${startRank + tail.length - 1}, calculated from cache ---`;
          this.elements.leaderboardList.appendChild(divider);
          tail.forEach((entry, index) => renderRow(entry, startRank + index));
        }
      } else {
        // Column sort: one unified list (served + cached), descending by
        // the chosen column; unknown values sink to the bottom. Click #
        // to restore rank order and the divider.
        const valueFor = (entry) => {
          const low = String(entry.username || "").trim().toLocaleLowerCase();
          if (sort.key === "op") return Number(entry.outpost_count || 0);
          if (["none", "regular", "mega", "ultra"].includes(sort.key)) {
            const kits = kitCounts.get(low);
            return kits ? Number(kits[sort.key] || 0) : -1;
          }
          if (["d1", "d7", "d30"].includes(sort.key)) {
            const uid = String(
              (this.searchEntries || []).find((c) => c.normalizedUsername === low)?.cell?.uid
              || uidByName.get(low) || "");
            const win = history?.windows?.[sort.key.slice(1)];
            if (!win || !uid) return Number.NEGATIVE_INFINITY;
            return Number(win.deltas?.[uid] ?? 0);
          }
          return 0;
        };
        const unified = [...servedRows, ...tail]
          .map((entry) => ({ entry, value: valueFor(entry) }))
          .sort((a, b) => b.value - a.value);
        const note = document.createElement("div");
        note.className = "leaderboard-divider";
        note.textContent = `--- sorted by column, served + cached mixed; click # to restore ---`;
        this.elements.leaderboardList.appendChild(note);
        unified.forEach((item, index) => renderRow(item.entry, index + 1));
      }
    } catch (error) {
      console.error(error);
      this.elements.leaderboardList.textContent = error.message || "Failed to load leaderboard.";
    }
  }

  async getLeaderboardRows(worldId) {
    if (this.leaderboardCache.has(worldId)) {
      return this.leaderboardCache.get(worldId);
    }

    if (this.leaderboardRequests.has(worldId)) {
      return this.leaderboardRequests.get(worldId);
    }

    const request = this.api.getLeaderboard(worldId, 2)
      .then((response) => {
        const rows = response.leaderboard || [];
        this.leaderboardCache.set(worldId, rows);
        // Fresh official counts just arrived: reconcile the explored cache
        // against them in the background. Fire-and-forget by design.
        this.reconcileLeaderboardDrift(worldId, rows).catch((error) => {
          debugLog("Leaderboard reconciliation failed.", error);
        });
        return rows;
      })
      .finally(() => {
        this.leaderboardRequests.delete(worldId);
      });

    this.leaderboardRequests.set(worldId, request);
    return request;
  }

  // --- Leaderboard drift reconciliation --------------------------------
  // The leaderboard's outpost counts are server truth; the map cache is
  // whatever getarea has shown us. When they disagree for a player, ONE
  // /base/load on that player's main returns their full outpost list
  // ([x, y, baseid] per save.model), and only the zones that actually
  // changed get a getarea refresh. Two hard rules shape this:
  //   1. Nothing from /base/load ever enters the map cache - the outpost
  //      list is only a hint for WHICH zones to refresh. The map displays
  //      getarea data exclusively, because base loads carry no zone-level
  //      context and would leave holes.
  //   2. It only runs where getarea is possible at all: the live session's
  //      own world. Cross-world browsing (viewing a server you are not in)
  //      can open bases from the archive but cannot getarea, so the
  //      renderer holds no game token there and the reconciler stays off.
  async reconcileLeaderboardDrift(worldId, rows) {
    if (!this.session || this.isGuestView) return;
    if (!this.renderer?.token) return; // cross-world view: no getarea here
    // Rows must belong to the session's own world: leaderboards can be
    // fetched for other worlds (exports, cross-world browsing) and those
    // must never be compared against this world's cache.
    if (worldId !== String(this.session?.map?.worldid || "").trim()) return;
    if (this.baseScanRunning || this.scanRunning) return;
    if (!Array.isArray(rows) || !rows.length) return;
    if (!this.leaderboardReconcileAt) this.leaderboardReconcileAt = new Map();
    const last = this.leaderboardReconcileAt.get(worldId) || 0;
    if (Date.now() - last < 60 * 60 * 1000) return; // once per world per hour
    this.leaderboardReconcileAt.set(worldId, Date.now());

    const cachedCounts = this.renderer.getOwnerOutpostCounts();
    // Index cached mains and per-player outpost coordinates in one pass.
    const mains = new Map();
    const cachedOutposts = new Map();
    for (const cell of this.renderer.cellCache.values()) {
      const owner = String(cell.n || "").trim().toLocaleLowerCase();
      if (!owner) continue;
      if (Number(cell.b) === MR2.yardTypes.main) {
        mains.set(owner, cell);
      } else if (Number(cell.b) === MR2.yardTypes.outpost) {
        if (!cachedOutposts.has(owner)) cachedOutposts.set(owner, []);
        cachedOutposts.get(owner).push(cell);
      }
    }

    // Drifted players whose main we can actually load. A player whose main
    // we have never explored (or whose cached main carries no base id) is
    // skipped cleanly - there is nothing to load a snapshot FROM, and the
    // regular scan/streaming will find them eventually.
    const candidates = [];
    let unknownMains = 0;
    for (const row of rows) {
      const name = String(row.username || "").trim().toLocaleLowerCase();
      if (!name) continue;
      const served = Number(row.outpost_count ?? row.outposts ?? NaN);
      if (!Number.isFinite(served)) continue;
      const cached = cachedCounts.get(name);
      if (cached === undefined || cached === served) continue;
      const main = mains.get(name);
      const baseid = String(main?.bid || "").trim();
      if (!main || !baseid || baseid === "0") { unknownMains += 1; continue; }
      candidates.push({ name, main, baseid, drift: Math.abs(served - cached) });
    }
    if (!candidates.length) {
      if (unknownMains) debugLog(`Leaderboard reconcile: ${unknownMains} drifted player(s) skipped (main not cached yet).`);
      return;
    }
    candidates.sort((a, b) => b.drift - a.drift);

    const MAX_PLAYERS = 15;
    const MAX_ZONES = 40;
    const zonesToRefresh = new Map();
    let loaded = 0;
    for (const candidate of candidates.slice(0, MAX_PLAYERS)) {
      if (zonesToRefresh.size >= MAX_ZONES) break;
      let snapshot = null;
      try {
        snapshot = await this.loadBaseSnapshot(candidate.baseid);
        loaded += 1;
      } catch (error) {
        debugLog(`Leaderboard reconcile: base load failed for ${candidate.name}.`, error);
        continue;
      }
      // save.model serializes outposts as [x, y, baseid][]; tolerate the
      // stringified form some responses use.
      let list = snapshot?.outposts;
      if (typeof list === "string") {
        try { list = JSON.parse(list); } catch { list = null; }
      }
      if (!Array.isArray(list)) continue;
      const truth = new Map();
      for (const entry of list) {
        if (!Array.isArray(entry) || entry.length < 2) continue;
        truth.set(cellKey(Number(entry[0]), Number(entry[1])), String(entry[2] ?? ""));
      }
      const markZone = (x, y) => {
        const zx = Math.floor(x / MR2.zoneSize) * MR2.zoneSize;
        const zy = Math.floor(y / MR2.zoneSize) * MR2.zoneSize;
        zonesToRefresh.set(`${zx},${zy}`, { x: zx, y: zy });
      };
      // New or moved outposts: in the snapshot, absent (or different) in cache.
      for (const [key, bid] of truth) {
        const [x, y] = key.split(",").map(Number);
        const cell = this.renderer.cellCache.get(key);
        const cachedOwner = String(cell?.n || "").trim().toLocaleLowerCase();
        const isTheirs = cell && Number(cell.b) === MR2.yardTypes.outpost
          && cachedOwner === candidate.name;
        if (!isTheirs || (bid && String(cell.bid || "") !== bid)) markZone(x, y);
      }
      // Vanished outposts: in cache, absent from the snapshot.
      for (const cell of cachedOutposts.get(candidate.name) || []) {
        if (!truth.has(cellKey(Number(cell.x), Number(cell.y)))) {
          markZone(Number(cell.x), Number(cell.y));
        }
      }
    }
    if (!zonesToRefresh.size) {
      debugLog(`Leaderboard reconcile: ${loaded} snapshot(s) checked, cache already agrees.`);
      return;
    }
    const zones = [...zonesToRefresh.values()].slice(0, MAX_ZONES);
    debugLog(`Leaderboard reconcile: refreshing ${zones.length} zone(s) for ${loaded} drifted player(s).`);
    for (const zone of zones) {
      try {
        // getarea is the ONLY writer to the map cache (rule 1 above).
        await this.renderer.reloadZoneNow(zone, FETCH_PRIORITY_BACKGROUND);
      } catch (error) {
        debugLog(`Leaderboard reconcile: zone ${zone.x},${zone.y} refresh failed.`, error);
      }
    }
  }

  // One background-priority /base/load snapshot with the standard stale
  // token recovery. Used for reconciliation only; the response is read for
  // its outpost list and never merged into the map.
  async loadBaseSnapshot(baseid) {
    const attempt = (token) => fetchJson(buildBymUrl("/base/load"), {
      method: "POST",
      headers: {
        "X-Fetch-Priority": String(FETCH_PRIORITY_BACKGROUND),
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
      },
      body: new URLSearchParams({
        type: "view",
        baseid: String(baseid),
        userid: String(this.session?.user?.userid ?? 0),
        mapversion: "2",
      }),
    });
    try {
      return await attempt(this.session?.token || "");
    } catch (error) {
      const status = Number(error?.status);
      if (status !== 401 && status !== 403) throw error;
      const fresh = String((await this.recoverSessionToken()) || "").trim();
      if (!fresh) throw error;
      return attempt(fresh);
    }
  }

  handleHoveredCell(cell) {
    // Hover no longer drives the cell popup - it opens on selection only - so
    // there is nothing to re-render here. The value is still tracked because
    // the map's own hover highlight and the coordinate readout use it.
    this.hoveredCell = cell;
  }

  handleSelectedCell(cell) {
    this.selectedCell = cell;
    this.profileOwnerId = null;
    this.renderDetails();
  }

  renderDetails() {
    const shouldAnimateDesktopResize = !this.isMobileLayout && Boolean(this.elements.detailsPanel);
    const previousDesktopDetailsHeight = shouldAnimateDesktopResize
      ? this.elements.detailsPanel.getBoundingClientRect().height
      : 0;
    const shouldAnimateMobileResize = (
      this.isMobileLayout &&
      Boolean(this.selectedCell) &&
      this.elements.appRoot.classList.contains("mobile-details-open")
    );
    const previousMobileDetailsHeight = shouldAnimateMobileResize
      ? this.elements.mobileDetailsSheet.getBoundingClientRect().height
      : 0;

    if (this.profileOwnerId) {
      this.renderProfilePanel(this.elements.detailsTitle, this.elements.detailsContent);
      this.renderProfilePanel(this.elements.mobileDetailsTitle, this.elements.mobileDetailsContent);
    } else {
      this.renderDetailsPanel({
        titleEl: this.elements.detailsTitle,
        contentEl: this.elements.detailsContent,
        cell: this.selectedCell || null,
        emptyMessage: "Select a visible MR2 cell to inspect it.",
      });
      this.renderDetailsPanel({
        titleEl: this.elements.mobileDetailsTitle,
        contentEl: this.elements.mobileDetailsContent,
        cell: this.selectedCell || null,
        emptyMessage: "Tap a visible MR2 cell to inspect it.",
      });
    }
    // The panel is a popup, not a permanent fixture: it stays closed until a
    // cell is actually selected, and the close button dismisses it. Hovering
    // no longer opens it, so it cannot follow the cursor around the map.
    this.syncDesktopDetailsState();
    this.animateDesktopDetailsResize(previousDesktopDetailsHeight, shouldAnimateDesktopResize);
    this.syncMobileDetailsState();
    this.animateMobileDetailsResize(previousMobileDetailsHeight, shouldAnimateMobileResize);
  }

  /**
   * Builds the "refresh this zone, then resolve the base id" step that runs
   * before a base loads.
   *
   * It used to be inlined in the View Yard click handler, which meant the
   * outpost picker and the retry button opened bases straight from cached
   * cell data - a stale or missing base id there failed with no way to
   * recover. Every path that opens a base now goes through this.
   */
  // Archived baseload summary, cached 5 min per uid. Fills the popup's
  // Joined/Seen rows (and feeds the Battle Logs modal) once it arrives.
  async getBaseData(uid) {
    const key = String(uid);
    const now = Date.now();
    this.basedataCache = this.basedataCache || new Map();
    const hit = this.basedataCache.get(key);
    if (hit && now - hit.at < 5 * 60 * 1000) return hit.data;
    let data = null;
    try { data = await fetchBaseData(key); } catch { data = null; }
    this.basedataCache.set(key, { at: now, data });
    return data;
  }

  fillBaseDataRows(uid) {
    const key = String(uid);
    this.getBaseData(uid).then((data) => {
      // Two fixes over the old getElementById version, both causes of
      // "sometimes the dates are wrong":
      //   1. The popup renders TWICE (desktop card + mobile sheet), so the
      //      ids are duplicated and getElementById only ever filled the
      //      first copy - the other kept its placeholder or stale text.
      //   2. Click A then B quickly and A's slow response used to land in
      //      B's freshly built rows. Each row now carries the uid it was
      //      built for, and a response only writes into rows stamped with
      //      ITS uid - a mismatched (stale) response writes nowhere.
      const joinedRows = [...document.querySelectorAll('[id="cg-joined"]')]
        .filter((el) => el.dataset.baseUid === key);
      const seenRows = [...document.querySelectorAll('[id="cg-seen"]')]
        .filter((el) => el.dataset.baseUid === key);
      if (!joinedRows.length && !seenRows.length) return; // closed, rebuilt, or stale
      if (!data?.found) {
        for (const el of joinedRows) el.textContent = "Joined: unknown";
        for (const el of seenRows) el.textContent = "Seen: unknown";
        return;
      }
      const joinedText = data.createtime > 0
        ? `Joined: ${new Date(data.createtime * 1000).toLocaleDateString()}`
        : "Joined: unknown";
      for (const el of joinedRows) el.textContent = joinedText;
      const seenText = data.savetime > 0
        ? `Seen: ${formatRelativeTime(data.savetime * 1000)}`
        : "Seen: unknown";
      for (const el of seenRows) {
        el.textContent = seenText;
        if (data.capturedAt) {
          el.title = `From the base archive captured ${formatRelativeTime(data.capturedAt)}`;
        }
      }
    });
  }

  openBattleLogsModal(cell) {
    const uid = Number(cell?.uid || 0);
    if (!uid) return;
    if (this.elements.modalBlocker) this.elements.modalBlocker.hidden = false;
    const modal = document.getElementById("battlelogs-modal");
    if (!modal) return;
    modal.hidden = false;
    const title = document.getElementById("battlelogs-title");
    const listEl = document.getElementById("battlelogs-list");
    const reportEl = document.getElementById("battlelogs-report");
    if (title) title.textContent = `Battle Logs - ${String(cell.n || "").trim() || `Player ${uid}`}`;
    if (listEl) listEl.innerHTML = '<p class="muted">Loading...</p>';
    if (reportEl) reportEl.innerHTML = "";
    this.getBaseData(uid).then((data) => {
      if (modal.hidden) return;
      if (!data?.found) {
        if (listEl) listEl.innerHTML = '<p class="muted">No archived base data for this player yet. View their yard once to capture it.</p>';
        return;
      }
      if (listEl) {
        listEl.textContent = "";
        const heading = document.createElement("p");
        heading.className = "battlelogs-heading";
        heading.textContent = "Recent attacks on this base:";
        listEl.appendChild(heading);
        const attacks = data.attacks || [];
        if (!attacks.length) {
          const none = document.createElement("p");
          none.className = "muted";
          none.textContent = "None recorded in the last save.";
          listEl.appendChild(none);
        }
        for (const attack of attacks) {
          const row = document.createElement("div");
          row.className = "battlelogs-row";
          if (attack.pic) {
            const avatar = document.createElement("img");
            avatar.className = "battlelogs-avatar";
            avatar.src = attack.pic;
            avatar.alt = "";
            avatar.loading = "lazy";
            avatar.addEventListener("error", () => avatar.remove());
            row.appendChild(avatar);
          }
          const text = document.createElement("span");
          const when = attack.starttime > 0 ? formatRelativeTime(attack.starttime * 1000) : "unknown time";
          text.textContent = `${attack.name || "?"} - ${when}${attack.count > 1 ? ` (x${attack.count})` : ""}`;
          row.appendChild(text);
          listEl.appendChild(row);
        }
        const stamp = document.createElement("p");
        stamp.className = "muted battlelogs-stamp";
        stamp.textContent = `As of the archive captured ${formatRelativeTime(data.capturedAt)}.`;
        listEl.appendChild(stamp);
      }
      if (reportEl) {
        const heading = document.createElement("p");
        heading.className = "battlelogs-heading";
        heading.textContent = "Most recent attack log:";
        reportEl.textContent = "";
        reportEl.appendChild(heading);
        const body = document.createElement("div");
        body.className = "battlelogs-report-body";
        const raw = String(data.attackreport || "").trim();
        if (!raw) {
          body.innerHTML = '<p class="muted">No attack report in the last save.</p>';
        } else {
          // Game-authored HTML (ul/li/font). Strip anything script-like
          // before injecting.
          const cleaned = raw
            .replace(/<\s*script[^>]*>[\s\S]*?<\s*\/\s*script\s*>/gi, "")
            .replace(/\son\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
            .replace(/javascript:/gi, "");
          body.innerHTML = cleaned;
        }
        reportEl.appendChild(body);
      }
    });
  }

  buildBasePrepare(cellX, cellY) {
    return async (setStatus) => {
      const zone = {
        x: Math.floor(cellX / MR2.zoneSize) * MR2.zoneSize,
        y: Math.floor(cellY / MR2.zoneSize) * MR2.zoneSize,
      };
      const known = this.renderer?.cellCache?.get(cellKey(cellX, cellY)) || null;
      try {
        if (this.isGuestView) {
          // The game API only serves cells for the signed-in player's own
          // world, so a guest-viewed world refreshes from the newest
          // shared-cache observation instead.
          setStatus("Refreshing zone from the shared cache\u2026");
          await this.renderer?.refreshZonesFromSharedCache([zone]);
        } else {
          setStatus("Reloading zone from the game server\u2026");
          // Dedicated priority-10 fetch, straight out - never queued behind
          // (or waiting on) the panning backlog for this zone.
          await this.renderer?.reloadZoneNow(zone, 10);
        }
      } catch (error) {
        // The base itself is still fetched live below; a failed zone refresh
        // only means we resolve from older cell data.
        console.warn("[BYM-MR2] Zone refresh before base view failed:", error);
      }
      const fresh = this.renderer?.cellCache?.get(cellKey(cellX, cellY)) || known;
      const baseid = String(fresh?.bid || known?.bid || "").trim();
      if (!baseid || baseid === "0") {
        throw new Error(this.isGuestView
          ? "No base id in the shared cache for this cell yet. It appears once a signed-in player on this world refreshes the zone."
          : "The game server reported no base id for this cell.");
      }
      return { baseid, name: String(fresh?.n || known?.n || "") };
    };
  }

  /**
   * Main yard first, then outposts by empire value descending, ties by x then
   * y - the order the yard viewer's picker shows them in.
   *
   * Membership comes from the base save when one is supplied: /base/load
   * returns the owner's complete outpost list, whereas the map cache only
   * holds zones this browser has actually fetched. Deriving the list purely
   * from the cache made the count read low for anyone who had not panned over
   * their whole empire, and read zero outright whenever getPlayerProfile bailed
   * on a hidden cell.
   *
   * The cache is still where the detail comes from: /base/load carries only
   * coordinates and base ids, so empire value - and therefore the kit - is
   * looked up per cell, and an outpost in an unexplored zone shows its kit as
   * a dash rather than being dropped.
   */
  buildOwnedBaseList(ownerId, authoritativeOutposts = null, homebase = null) {
    const cells = this.renderer?.getPlayerProfile(Number(ownerId))?.cells || [];
    const byCoord = new Map();
    for (const entry of cells) {
      byCoord.set(`${Number(entry.x)},${Number(entry.y)}`, entry);
    }

    // getarea reports v per cell from that cell's own save, so this is the
    // outpost's own empire value - not the owner's maximum, which would
    // classify every outpost of a large player as Ultra.
    const describe = (x, y, isMain, baseid) => {
      const cached = byCoord.get(`${x},${y}`);
      // The owner profile is the preferred source, but it is scoped to one
      // player and collapses to null the moment any of their cells is hidden.
      // Terrain height does not depend on ownership, so fall back to the cell
      // cache directly rather than opening the base on default grass.
      const direct = cached || this.renderer?.getCachedCell(x, y) || null;
      const known = cached !== undefined;
      const value = Number(cached?.v || 0);
      return {
        x, y,
        baseid: String(baseid || direct?.bid || ""),
        value,
        isMain,
        known,
        // Carried so the picker can open a base with the same ground the
        // map would have given it.
        terrainHeight: Number(direct?.i),
        kit: isMain ? "N/A" : (known ? this.describeOutpostKit(value) : "\u2014"),
      };
    };

    const cachedOf = (kind) => cells
      .filter((entry) => Number(entry.b) === kind)
      .map((entry) => describe(Number(entry.x), Number(entry.y),
        kind === MR2.yardTypes.main, entry.bid));

    const main = cachedOf(MR2.yardTypes.main);
    if (!main.length && Array.isArray(homebase) && homebase.length === 2) {
      main.push(describe(Number(homebase[0]), Number(homebase[1]), true, ""));
    }

    const fromSave = Array.isArray(authoritativeOutposts)
      ? authoritativeOutposts
          .map((entry) => (Array.isArray(entry)
            ? { x: Number(entry[0]), y: Number(entry[1]), baseid: entry[2] }
            : { x: Number(entry?.x), y: Number(entry?.y), baseid: entry?.baseid }))
          .filter((entry) => Number.isFinite(entry.x) && Number.isFinite(entry.y))
          .map((entry) => describe(entry.x, entry.y, false, entry.baseid))
      : [];

    const outposts = (fromSave.length ? fromSave : cachedOf(MR2.yardTypes.outpost))
      .sort((left, right) => (right.value - left.value)
        || (left.x - right.x) || (left.y - right.y));

    // The Inferno yard sits directly under the main yard, always second and
    // never sorted among the outposts. It is not a map cell: the cavern is
    // synthesised at INFERNOPORTAL.AddPortal's Point(-1200, -150), and the
    // picker shows the yard's own nominal coordinates (-666, -666) with no
    // kit, since an Inferno yard has no outpost kit.
    //
    // Listed whenever the main yard is - the same condition under which the
    // cavern itself is drawn (isOwnYard && isMain in openBaseView). The save
    // cannot be used to gate it: `baseid_inferno` reads 0 even for a player
    // who demonstrably has an Inferno base.
    const inferno = main.length
      ? [{
        x: INFERNO_LIST_COORD.x,
        y: INFERNO_LIST_COORD.y,
        baseid: "0",
        value: 0,
        isMain: false,
        isInferno: true,
        known: true,
        terrainHeight: undefined,
        kit: "N/A",
      }]
      : [];

    return [...main, ...inferno, ...outposts];
  }

  renderDetailsPanel({ titleEl, contentEl, cell, emptyMessage }) {
    if (!titleEl || !contentEl) {
      return;
    }

    contentEl.replaceChildren();

    if (!cell) {
      titleEl.textContent = "No selection";
      contentEl.textContent = emptyMessage;
      return;
    }

    if (this.isPlayerHidden(cell.n) && !this.isViewerAdmin) {
      titleEl.textContent = `${cell.x}, ${cell.y}`;
      contentEl.textContent = "This cell is not available.";
      return;
    }

    titleEl.textContent = cell.n || `${cell.x}, ${cell.y}`;

    const baseType = Number(cell.b);
    const isMainYard = baseType === MR2.yardTypes.main;
    const isOutpostCell = baseType === MR2.yardTypes.outpost;

    if (isMainYard || isOutpostCell) {
      this.renderOwnedCellSummary(contentEl, cell, isMainYard);
    } else if (baseType === MR2.yardTypes.wildMonster) {
      // Wild tribe card: the tribe's popup art in the picture slot, then
      // coords+type, tribe (level), damage, and freshness.
      const grid = document.createElement("div");
      grid.className = "cellgrid";
      const avatarCol = document.createElement("div");
      avatarCol.className = "cg-avatar";
      const pic = document.createElement("img");
      pic.className = "cell-owner-photo";
      pic.alt = `${describeTribe(cell)} tribe`;
      const tribeKey = getTribeKey(cell);
      pic.src = tribeKey
        ? `${this.config?.bymBaseUrl || ""}/assets/popups/tribe_${tribeKey}.v2.png`
        : `${this.config?.cdnBaseUrl || ""}/assets/bym-refitted-assets/placeholder.jpg`;
      avatarCol.appendChild(pic);
      grid.appendChild(avatarCol);
      const infoCol = document.createElement("div");
      infoCol.className = "cg-col cg-id";
      grid.appendChild(infoCol);
      const line = (text, cls = "") => {
        const el = document.createElement("p");
        el.className = `cg-line ${cls}`.trim();
        el.textContent = text;
        infoCol.appendChild(el);
      };
      line(`${cell.x}x${cell.y} Wild Monster Tribe`, "cg-name");
      line(`${describeTribe(cell)} (${formatNumber(Number(cell.l || 0))})`);
      line(`Damage: ${formatNumber(Number(cell.dm || 0))}%`);
      const seenAt = this.getCellObservedAt(cell);
      line(`Cell last updated: ${seenAt > 0 ? formatRelativeTime(seenAt) : "unknown"}`);
      const actCol = document.createElement("div");
      actCol.className = "cg-col cg-actions";
      grid.appendChild(actCol);
      this._cellGridActions = actCol;
      contentEl.appendChild(grid);
    } else {
      // Empty / unowned cells: plain themed rows.
      const grid = document.createElement("div");
      grid.className = "cellgrid";
      const infoCol = document.createElement("div");
      infoCol.className = "cg-col cg-id";
      for (const [label, value] of this.buildDetailRows(cell)) {
        const el = document.createElement("p");
        el.className = "cg-line";
        el.innerHTML = `<strong>${escapeHtml(label)}:</strong> ${escapeHtml(value)}`;
        infoCol.appendChild(el);
      }
      grid.appendChild(infoCol);
      const actCol = document.createElement("div");
      actCol.className = "cg-col cg-actions";
      grid.appendChild(actCol);
      this._cellGridActions = actCol;
      contentEl.appendChild(grid);
    }

    // Player cells route their buttons into the grid's action column;
    // wild camps and non-base cells keep the old stacked action list.
    const actions = this._cellGridActions
      || (() => {
        const el = document.createElement("div");
        el.className = "detail-actions";
        return el;
      })();

    // Wild monster camps have no owner (uid 0) but do carry a base id, so
    // they open in the viewer like any other base - the guard used to be
    // owner-based and shut them out. baseType is already in scope from the
    // summary branch above; redeclaring it here was a SyntaxError that took
    // the whole module out.
    const isWildCamp = baseType === MR2.yardTypes.wildMonster;
    if (Number(cell.uid || 0) > 0 || isWildCamp) {
      // Base viewer: read-only popup rendered with the real game sprites.
      // Clicking reloads the cell's zone from the game server first, so the
      // base id and ownership are current, then loads and renders the base.
      if (baseType === MR2.yardTypes.main || baseType === MR2.yardTypes.outpost
        || isWildCamp) {
        const isMain = baseType === MR2.yardTypes.main;
        // The game's cell popup offers Bookmark right on the plate: a
        // Button_CLIP, greyed once the location is already saved. Adding
        // routes through the PopupNewBookmark-style modal; the 8-cap and
        // duplicate rules live in handleAddBookmark.
        if (this.session && (baseType === MR2.yardTypes.main
          || baseType === MR2.yardTypes.outpost
          || baseType === MR2.yardTypes.wildMonster)) {
          const already = (this.bookmarks || []).some(
            (b) => b.x === Number(cell.x) && b.y === Number(cell.y),
          );
          const bookmarkButton = document.createElement("button");
          bookmarkButton.type = "button";
          bookmarkButton.className = "game-button cell-action-button cell-bookmark-button";
          bookmarkButton.textContent = "Bookmark";
          if (already) {
            bookmarkButton.setAttribute("aria-disabled", "true");
            bookmarkButton.disabled = true;
            bookmarkButton.title = "Already bookmarked";
          } else {
            bookmarkButton.addEventListener("click", () =>
              this.openBookmarkAddModal(cell));
          }
          (this._cellGridActions || contentEl).appendChild(bookmarkButton);
        }
        if (isMain && Number(cell.uid || 0) > 0) {
          const logsButton = document.createElement("button");
          logsButton.type = "button";
          logsButton.className = "game-button cell-action-button cell-logs-button";
          logsButton.textContent = "Battle Logs";
          logsButton.addEventListener("click", () => this.openBattleLogsModal(cell));
          (this._cellGridActions || contentEl).appendChild(logsButton);
        }
        const viewBaseButton = document.createElement("button");
        viewBaseButton.type = "button";
        viewBaseButton.className = "game-button cell-action-button cell-view-button";
        viewBaseButton.textContent = isWildCamp
          ? "View Camp"
          : (isMain ? "View Yard" : "View Outpost");
        const token = this.session?.token || "";
        if (!token) {
          // Signed-out visitors get the sign-in form rather than a dead
          // control: the base viewer needs a session, and hiding that behind
          // a disabled button gives them nothing to act on.
          viewBaseButton.title = "Sign in to view bases";
          viewBaseButton.addEventListener("click", () => {
            this.openAccountModal();
            this.elements.emailInput?.focus();
            const kind = isWildCamp ? "camp" : (isMain ? "yard" : "outpost");
            this.setSessionStatus?.(`Sign in to view ${cell.n ? `${cell.n}'s ` : ""}${kind}.`);
          });
        } else {
          viewBaseButton.addEventListener("click", () => {
            const cellX = Number(cell.x);
            const cellY = Number(cell.y);
            openBaseView({
              // Read the token at click time, and let the popup recover if
              // the session rotates while it is loading.
              token: this.session?.token || token,
              recoverToken: () => this.recoverSessionToken(),
              userid: this.session?.user?.userid ?? 0,
              name: String(cell.n || "").trim(),
              isMain,
              isWild: isWildCamp,
              // Your own base gets the white yard boundary and the resource
              // readout, matching how the game presents it.
              isAdmin: Boolean(this.isViewerAdmin),
              isOwnYard: Number(cell.uid || 0) > 0
                && Number(cell.uid) === Number(this.session?.user?.userid ?? -1),
              // Visiting someone else's yard shows their picture on the
              // level plate (UI_TOP frame "view"). Outposts carry no avatar,
              // so fall back to the owner's main cell, which does.
              ownerPic: this.getCellAvatarUrl(cell)
                || this.getCellAvatarUrl(
                  (this.renderer?.getPlayerProfile(Number(cell.uid))?.cells || [])
                    .find((entry) => Number(entry.b) === MR2.yardTypes.main),
                ),
              // The map cache knows every base this player owns, which is
              // more reliable than the base save's own outposts field. Main
              // yard first, then outposts by empire value.
              outpostList: this.buildOwnedBaseList(cell.uid),
              // getarea's `i` is the cell's terrain height (userCell.ts and
              // wildMonsterCell.ts both emit `i: cell.terrainHeight`), which
              // is what MapRoomCell turns into a ground texture.
              terrainHeight: Number(cell.i),
              // Lets the viewer refresh a zone before opening any base from
              // the picker, exactly as this click does.
              prepareFor: (px, py) => this.buildBasePrepare(px, py),
              // Called once /base/load answers, so the list can be rebuilt
              // from the save's own outpost array rather than the cache.
              baseListFor: (saveOutposts, homebase) =>
                this.buildOwnedBaseList(cell.uid, saveOutposts, homebase),
              x: cellX,
              y: cellY,
              prepare: this.buildBasePrepare(cellX, cellY),
            }).catch((error) => console.error("[BYM-MR2] Base view failed:", error));
          });
        }
        actions.appendChild(viewBaseButton);
      }
    }

    const linkButton = document.createElement("button");
    linkButton.type = "button";
    linkButton.className = "game-button cell-action-button cell-copy-button";
    linkButton.textContent = "Copy Link";
    linkButton.addEventListener("click", () => this.copyCellLink(cell, linkButton));
    actions.appendChild(linkButton);

    if (!this._cellGridActions) contentEl.appendChild(actions);
    this._cellGridActions = null;
  }

  // ------------------------------------------------------------------
  // Player-owned cell summary (main yards and outposts).
  //
  // Layout, top to bottom: avatar, "Name (level) - Alliance", what and where,
  // outpost count, main-yard link for outposts, then a rule, then the scouting
  // block (kit, freshness, damage, flinger), then an admin-only loot block.
  // Buttons are appended by the caller.
  // ------------------------------------------------------------------
  renderOwnedCellSummary(contentEl, cell, isMain) {
    const name = String(cell.n || "").trim();
    const ownerId = Number(cell.uid || 0);
    const profile = ownerId > 0 ? this.renderer?.getPlayerProfile(ownerId) : null;

    // Avatar: the game's own picture from the cached main-base cell, falling
    // back through the profile store to the game placeholder, exactly as the
    // profile panel resolves it.
    const photo = document.createElement("img");
    photo.className = "cell-owner-photo";
    photo.alt = name ? `${name}'s avatar` : "Owner avatar";
    const placeholder = `${this.config?.cdnBaseUrl || ""}/assets/bym-refitted-assets/placeholder.jpg`;
    const nameLower = name.toLocaleLowerCase();
    const ownName = String(this.session?.user?.username || "").trim().toLocaleLowerCase();
    const picture = this.getCellAvatarUrl(cell)
      || this.getCellAvatarUrl(profile?.main)
      || (profile?.cells || []).map((entry) => this.getCellAvatarUrl(entry)).find(Boolean)
      || "";
    if (picture) {
      photo.src = picture;
    } else if (ownName && nameLower === ownName && this.session?.user?.pic_square) {
      photo.src = this.session.user.pic_square;
    } else if (this.profilePicCache.has(nameLower)) {
      photo.src = this.profilePicCache.get(nameLower) || placeholder;
    } else {
      photo.src = placeholder;
      if (name) {
        fetchPublicProfile(name)
          .then((payload) => {
            const pic = String(payload?.pic || "").trim();
            this.profilePicCache.set(nameLower, pic);
            if (pic && photo.isConnected) photo.src = pic;
          })
          .catch(() => this.profilePicCache.set(nameLower, ""));
      }
    }
    photo.addEventListener("error", () => {
      if (photo.src !== placeholder) photo.src = placeholder;
    });

    // ---- The desktop cell card: avatar | identity | status | loot | actions
    const grid = document.createElement("div");
    grid.className = "cellgrid";
    const avatarCol = document.createElement("div");
    avatarCol.className = "cg-avatar";
    avatarCol.appendChild(photo);
    grid.appendChild(avatarCol);

    const col = (cls) => {
      const el = document.createElement("div");
      el.className = `cg-col ${cls}`;
      grid.appendChild(el);
      return el;
    };
    const rowIn = (parent, text, cls = "") => {
      const line = document.createElement("p");
      line.className = `cg-line ${cls}`.trim();
      line.textContent = text;
      parent.appendChild(line);
      return line;
    };

    const mainCell = profile?.main || (isMain ? cell : null);
    const playerLevel = Number((mainCell || cell).l || 0);
    const allianceName = this.getPlayerAllianceName(name);
    const counts = ownerId > 0
      ? (this.renderer?.getOwnedBaseCounts(ownerId) || { outpost: 0 })
      : { outpost: 0 };

    // Column 1: identity - coords+type on top, then who they are.
    const idCol = col("cg-id");
    rowIn(idCol, `${cell.x}x${cell.y} - ${isMain ? "Main Yard" : "Outpost"}`, "cg-name");
    // "Rank #N - Name (level)", the name tinted by relation like everywhere
    // else. Rank falls off (not blank) while the leaderboard rows load.
    const identityLine = document.createElement("p");
    identityLine.className = "cg-line cg-name";
    const lbRank = this.getLeaderboardRank(name);
    if (lbRank) identityLine.append(`Rank #${formatNumber(lbRank)} - `);
    const identityName = document.createElement("span");
    const identityRel = this.nameRelationClass(name);
    if (identityRel) identityName.className = identityRel;
    identityName.textContent = name || `Player ${ownerId}`;
    identityLine.append(identityName, ` (${formatNumber(playerLevel)})`);
    idCol.appendChild(identityLine);
    rowIn(idCol, allianceName || "\u2014", "cg-alliance");
    rowIn(idCol, `Total Outposts: ${formatNumber(counts.outpost)}`);
    const kits = this.renderer?.getOwnerKitCounts?.()
      ?.get(String(name || "").trim().toLocaleLowerCase()) || null;
    rowIn(idCol, `N:${formatNumber(kits?.none || 0)} R:${formatNumber(kits?.regular || 0)} M:${formatNumber(kits?.mega || 0)} U:${formatNumber(kits?.ultra || 0)}`);

    // Column 2: status
    const stCol = col("cg-status");
    if (!isMain) {
      rowIn(stCol, `Kit: ${this.describeOutpostKit(Number(cell.v || 0))}`);
    }
    if (isMain && ownerId > 0) {
      const joinedRow = rowIn(stCol, "Joined: ...");
      joinedRow.id = "cg-joined";
      joinedRow.dataset.baseUid = String(ownerId);
      const seenRow = rowIn(stCol, "Seen: ...");
      seenRow.id = "cg-seen";
      seenRow.dataset.baseUid = String(ownerId);
      this.fillBaseDataRows(ownerId);
    }
    rowIn(stCol, `Damage: ${formatNumber(Number(cell.dm || 0))}%`);
    rowIn(stCol, `Flinger: ${formatNumber(getFlingerRange(cell.f, isMain))} cells (lv ${formatNumber(Number(cell.f || 0))})`);
    const observedAt = this.getCellObservedAt(cell);
    rowIn(stCol, `Cell last updated: ${observedAt > 0 ? formatRelativeTime(observedAt) : "unknown"}`);

    // Column 3: loot (mains, administrators, toggle on)
    if (this.showLootInfo && isMain) {
      const lootCol = col("cg-loot");
      rowIn(lootCol, `Loot: ${formatNumber(getCellLootTotal(cell))}`, "cg-name");
      for (const [key, label] of [["r1", "Twigs"], ["r2", "Pebbles"], ["r3", "Putty"], ["r4", "Goo"]]) {
        rowIn(lootCol, `${label}: ${formatNumber(Number(cell.r?.[key] || 0))}`);
      }
    }

    // Column 4: actions - filled by the caller (alliance / bookmark /
    // view / copy link, plus Jump to Main for outposts) so every control
    // keeps its existing behaviour. All wear the Bookmark game-button.
    const actCol = col("cg-actions");
    if (!isMain && mainCell) {
      const jump = document.createElement("button");
      jump.type = "button";
      jump.className = "game-button cell-action-button cg-act-first";
      jump.textContent = "Jump to Main";
      jump.title = `Jump to ${name || "this player"}'s main yard`;
      jump.addEventListener("click", () =>
        this.renderer?.jumpToCoordinates(Number(mainCell.x), Number(mainCell.y)));
      actCol.appendChild(jump);
    } else if (this.session && this.alliance && name) {
      // Invite / kick, rank-gated like the roster controls.
      const low = name.toLocaleLowerCase();
      const own = String(this.session?.user?.username || "").trim().toLocaleLowerCase();
      const isMember = this.allianceMemberMeta?.has(low);
      const myRank = String(this.alliance.yourRank || "member");
      const rankValue = { recruit: 0, member: 1, officer: 2, leader: 3 }[myRank] ?? 1;
      if (low !== own) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "game-button cell-action-button cg-act-first";
        if (!isMember && rankValue >= 1) {
          btn.textContent = "Alliance Invite";
          btn.title = `Invite ${name} to your alliance`;
          btn.addEventListener("click", () =>
            this.allianceAction("invite", { name }, null));
          actCol.appendChild(btn);
        } else if (isMember && rankValue >= 2) {
          btn.textContent = "Kick";
          btn.title = `Kick ${name} from your alliance`;
          btn.addEventListener("click", () =>
            this.allianceAction("kick", { name }, null));
          actCol.appendChild(btn);
        }
      }
    }
    this._cellGridActions = actCol;

    contentEl.appendChild(grid);
  }

  openPlayerProfile(ownerId) {
    if (!this.renderer) {
      return;
    }

    this.profileOwnerId = Number(ownerId || 0) > 0 ? Number(ownerId) : null;
    debugLog("Opening player profile for uid", this.profileOwnerId);
    this.renderDetails();
  }

  // Extracts an avatar URL from a cached cell. Main-base cells in the
  // getarea payload carry the owner's Discord-CDN avatar link; the exact
  // field name is tolerated loosely since it is game-defined.
  getCellAvatarUrl(cell) {
    if (!cell || typeof cell !== "object") {
      return "";
    }
    for (const key of ["pic_square", "im", "pic", "picSquare", "avatar", "avatarUrl", "img", "picture"]) {
      const value = String(cell[key] || "").trim();
      if (value.startsWith("http://") || value.startsWith("https://")) {
        return value;
      }
    }
    return "";
  }

  renderProfilePanel(titleEl, contentEl) {
    if (!titleEl || !contentEl) {
      return;
    }

    contentEl.replaceChildren();
    const profile = this.renderer?.getPlayerProfile(this.profileOwnerId);

    const backButton = document.createElement("button");
    backButton.type = "button";
    backButton.className = "secondary-button profile-back";
    backButton.textContent = "< Back to cell";
    backButton.addEventListener("click", () => {
      this.profileOwnerId = null;
      this.renderDetails();
    });
    contentEl.appendChild(backButton);

    if (!profile) {
      titleEl.textContent = "Player profile";
      const empty = document.createElement("p");
      empty.className = "muted";
      empty.textContent = "No cells known for this player yet. Explore or scan more of the map.";
      contentEl.appendChild(empty);
      return;
    }

    titleEl.textContent = profile.name;

    // Game avatar. The getarea payload for a MAIN base cell carries the
    // owner's avatar URL (a Discord CDN link), so the cached main is the
    // primary source and works for any explored player. Fallbacks: the
    // signed-in user's own session avatar, then the viewer's public profile
    // store (captured at that player's last viewer sign-in), then the game
    // placeholder.
    const photo = document.createElement("img");
    photo.className = "profile-photo";
    photo.alt = `${profile.name}'s avatar`;
    const placeholder = `${this.config?.cdnBaseUrl || ""}/assets/bym-refitted-assets/placeholder.jpg`;
    const ownName = String(this.session?.user?.username || "").trim().toLocaleLowerCase();
    const profileNameLower = String(profile.name || "").trim().toLocaleLowerCase();

    const mainPic = this.getCellAvatarUrl(profile.main) ||
      profile.cells.map((cell) => this.getCellAvatarUrl(cell)).find(Boolean) || "";

    if (mainPic) {
      photo.src = mainPic;
    } else if (ownName && profileNameLower === ownName && this.session?.user?.pic_square) {
      photo.src = this.session.user.pic_square;
    } else if (this.profilePicCache.has(profileNameLower)) {
      photo.src = this.profilePicCache.get(profileNameLower) || placeholder;
    } else {
      photo.src = placeholder;
      fetchPublicProfile(profile.name)
        .then((payload) => {
          const pic = String(payload?.pic || "").trim();
          this.profilePicCache.set(profileNameLower, pic);
          if (pic && photo.isConnected) {
            photo.src = pic;
          }
        })
        .catch(() => {
          this.profilePicCache.set(profileNameLower, "");
        });
    }
    photo.addEventListener("error", () => {
      if (photo.src !== placeholder) {
        photo.src = placeholder;
      }
    });
    contentEl.appendChild(photo);

    const rows = [
      ["Known bases", `${formatNumber(profile.cells.length)} (${profile.main ? "main + " : ""}${formatNumber(profile.outposts.length)} outposts)`],
      ["Empire value", formatNumber(profile.empireValue)],
    ];
    // Freshness of what we are showing: the newest zone fetch covering any
    // of this player's cells.
    let lastUpdated = 0;
    for (const cell of profile.cells) {
      const zoneX = Math.floor(cell.x / MR2.zoneSize) * MR2.zoneSize;
      const zoneY = Math.floor(cell.y / MR2.zoneSize) * MR2.zoneSize;
      lastUpdated = Math.max(lastUpdated, Number(this.renderer?.loadedZones?.get(`${zoneX},${zoneY}`) || 0));
    }
    if (lastUpdated > 0) {
      rows.push(["Last updated", formatRelativeTime(lastUpdated)]);
    }
    if (profile.distanceFromHome !== null) {
      rows.push(["Main distance", formatDistance(profile.distanceFromHome)]);
    }

    for (const [label, value] of rows) {
      const row = document.createElement("div");
      row.className = "detail-row";
      row.innerHTML = `<span class="detail-label">${escapeHtml(label)}</span><span>${escapeHtml(value)}</span>`;
      contentEl.appendChild(row);
    }

    const list = document.createElement("div");
    list.className = "profile-base-list";

    for (const cell of profile.cells) {
      const isMain = Number(cell.b) === MR2.yardTypes.main;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "profile-base";
      const flinger = Number(cell.f || 0) > 0 ? ` F${Number(cell.f)}` : "";
      const damage = Number(cell.dm || 0) > 0 ? ` ${Number(cell.dm)}% dmg` : "";
      button.innerHTML =
        `<span>${isMain ? "Main yard" : "Outpost"} (L${formatNumber(Number(cell.l || 0))}${escapeHtml(flinger)})${escapeHtml(damage)}</span>` +
        `<span class="profile-base-meta">${cell.x}, ${cell.y}</span>`;
      button.title = `Jump to ${cell.x}, ${cell.y}`;
      button.addEventListener("click", () => {
        this.renderer?.jumpToCoordinates(cell.x, cell.y);
      });
      list.appendChild(button);
    }

    contentEl.appendChild(list);

    // Capture/loss history assembled from watch activity involving this
    // player (as the actor or as the other party).
    const profileName = String(profile.name || "").trim().toLocaleLowerCase();
    const history = [];
    for (const event of this.watchEvents?.activity || []) {
      const actor = String(event.playerName || "").trim().toLocaleLowerCase();
      const other = String(event.otherParty || "").trim().toLocaleLowerCase();
      if (profileName && (actor === profileName || other === profileName)) {
        history.push({ ...event, actorIsProfile: actor === profileName });
      }
    }
    history.sort((left, right) => Number(right.at || 0) - Number(left.at || 0));

    if (history.length) {
      const heading = document.createElement("p");
      heading.className = "watch-subheading";
      heading.textContent = "Recent activity";
      contentEl.appendChild(heading);

      const activity = document.createElement("div");
      activity.className = "profile-activity";
      for (const event of history.slice(0, 12)) {
        const entry = document.createElement("div");
        entry.className = "watch-event";
        let verb;
        if (event.kind === "moved") {
          verb = "moved";
        } else if (event.kind === "captured") {
          verb = event.actorIsProfile ? "captured" : "lost to";
        } else {
          verb = event.actorIsProfile ? "lost" : "took from";
        }
        const counterpart = event.kind === "moved"
          ? ""
          : (event.actorIsProfile ? event.otherParty : event.playerName);
        const atX = event.x ?? event.fromX;
        const atY = event.y ?? event.fromY;
        entry.innerHTML =
          `<span>${verb} ${escapeHtml(String(event.cellType || "a base"))} at ${Number(atX)}, ${Number(atY)}` +
          `${counterpart ? ` (${escapeHtml(String(counterpart))})` : ""}</span>` +
          `<span class="watch-event-time">${escapeHtml(formatRelativeTime(Number(event.at || 0)))}</span>`;
        activity.appendChild(entry);
      }
      contentEl.appendChild(activity);
    }
  }

  async copyCellLink(cell, button) {
    // The link pins the world being viewed, so the recipient lands on the
    // same server's map (live if it is their own, cached otherwise).
    const world = String(this.viewedWorldId || this.session?.map?.worldid || "").trim();
    const worldParam = world ? `world=${encodeURIComponent(world)}&` : "";
    const url = `${window.location.origin}${window.location.pathname}?${worldParam}x=${cell.x}&y=${cell.y}`;
    let copied = false;

    try {
      await navigator.clipboard.writeText(url);
      copied = true;
    } catch (error) {
      // Fallback for contexts without the async clipboard API.
      try {
        const input = document.createElement("textarea");
        input.value = url;
        input.style.position = "fixed";
        input.style.opacity = "0";
        document.body.appendChild(input);
        input.select();
        copied = document.execCommand("copy");
        input.remove();
      } catch (fallbackError) {
        console.warn("[BYM-MR2] Clipboard copy failed.", fallbackError);
      }
    }

    debugLog("Copy link:", url, copied ? "(copied)" : "(copy failed)");
    if (button) {
      const original = "Copy Link to Cell";
      button.textContent = copied ? "Link Copied!" : url;
      window.setTimeout(() => {
        button.textContent = original;
      }, 1800);
    }
  }

  // Outpost kit tier, inferred from empire value.
  //
  // Kits are prefab layouts bought from the game's outpost kit popup, and
  // nothing in the map or base data records which one an outpost has: the
  // "prefab" field is the building's LEVEL, and it is only written while the
  // kit is still under construction. So the tier has to be inferred, and the
  // only usable signal is empire value.
  //
  // The figures below are each kit's own empire value, computed by running
  // the game's CalcBaseValue over the kit layouts extracted from the client
  //   value = ceil(0.1 * sum(build time + r1 + r2 + r3 + r4)) per building,
  //   skipping decoration/enemy/immovable/trap classes
  // giving Regular 3,210,880 | Mega 15,930,337 | Ultra 42,686,223. Each
  // threshold sits 25% under its kit, so a partly demolished or damaged
  // outpost still reads as the kit it was built from. The tiers are ~5x and
  // ~2.7x apart, so even at 25% no kit can reach the band above it.
  //
  // A kit's value is a FLOOR - owners upgrade past it - so this reads as
  // "this kit or better". An outpost hand-built to these values reports a
  // kit it never had; that misread is accepted.
  describeOutpostKit(empireValue) {
    return describeOutpostKitLabel(getOutpostKitKey(empireValue)) +
      getOutpostKitSuffix(empireValue);
  }

  // Newest observation covering this cell's zone, used for the "last updated"
  // line. Zones are keyed by their origin in loadedZones.
  getCellObservedAt(cell) {
    const zoneX = Math.floor(Number(cell.x) / MR2.zoneSize) * MR2.zoneSize;
    const zoneY = Math.floor(Number(cell.y) / MR2.zoneSize) * MR2.zoneSize;
    return Number(this.renderer?.loadedZones?.get(`${zoneX},${zoneY}`) || 0);
  }

  // Alliance name for a player, when they are in the viewer's alliance. Only
  // our own alliance's membership is known to the client, so anyone else
  // returns "" and the line is omitted rather than showing a wrong answer.
  getPlayerAllianceName(playerName) {
    const name = String(playerName || "").trim();
    if (!name || !this.alliance) return "";
    return this.allianceMemberNames?.has(name) ? String(this.alliance.name || "").trim() : "";
  }

  buildDetailRows(cell) {
    const isWild = Number(cell.b) === MR2.yardTypes.wildMonster;
    const isMain = Number(cell.b) === MR2.yardTypes.main;
    const isOutpost = Number(cell.b) === MR2.yardTypes.outpost;

    const rows = [
      ["Coordinates", `${cell.x}, ${cell.y}`],
      ["Type", describeYardType(cell)],
      ["Level", formatNumber(Number(cell.l || 0))],
    ];

    if (isWild) {
      rows.push(["Tribe", describeTribe(cell)]);
    }

    if ((isMain || isOutpost) && Number(cell.v || 0) > 0) {
      rows.push(["Empire Value", formatNumber(Number(cell.v || 0))]);
    }

    // Loot (Loot total, Twigs, Pebbles, Putty, Goo) is sensitive raid intel:
    // administrators only, and only while "Show loot in cell info" is ticked.
    // That is deliberately a different switch from the on-map pills - opening
    // a cell should not surface raid numbers just because the map is showing
    // them.
    if (this.showLootInfo
      && Number(cell.b) === MR2.yardTypes.main) {
      const lootTotal = getCellLootTotal(cell);
      if (lootTotal > 0) {
        rows.push(["Loot", formatNumber(lootTotal)]);
        const resourceNames = { r1: "Twigs", r2: "Pebbles", r3: "Putty", r4: "Goo" };
        for (const key of ["r1", "r2", "r3", "r4"]) {
          const amount = Number(cell.r?.[key] || 0);
          if (amount > 0) {
            rows.push([`  ${resourceNames[key]}`, formatNumber(amount)]);
          }
        }
      }
    }

    const flingerRange = getFlingerRange(cell.f, isMain);
    if (flingerRange > 0) {
      rows.push(["Flinger Range", `${formatNumber(flingerRange)} cells (level ${formatNumber(Number(cell.f || 0))})`]);
    }

    if (Number(cell.c || 0) > 0) {
      rows.push(["Catapult", `Level ${formatNumber(Number(cell.c || 0))}`]);
    }

    rows.push(["Damage", `${formatNumber(Number(cell.dm || 0))}%`]);

    if (Number(cell.d || 0) === 1) {
      rows.push(["Status", "Destroyed"]);
    }

    if (Number(cell.p || 0) === 1) {
      rows.push(["Protection", "Damage protection"]);
    }

    if (Number(cell.lo || 0) > 0 && Number(cell.mine || 0) !== 1) {
      rows.push(["Locked", "Owner online or under attack"]);
    }

    // Outpost stored resources are loot intel too: same gate as the
    // main-yard block above.
    if (this.isViewerAdmin && this.showLootInfo && isOutpost
      && cell.r && typeof cell.r === "object") {
      const resourceLabels = [
        ["r1", "Twigs"],
        ["r2", "Pebbles"],
        ["r3", "Putty"],
        ["r4", "Goo"],
      ];
      for (const [key, label] of resourceLabels) {
        const amount = Number(cell.r[key] || 0);
        if (amount > 0) {
          rows.push([label, formatNumber(amount)]);
        }
      }
    }

    if ((isMain || isOutpost) && Number(cell.uid || 0) > 0) {
      const ownedBaseCounts = this.renderer?.getOwnedBaseCounts(cell.uid) || { outpost: 0 };
      rows.push(["Owned Outposts", formatNumber(ownedBaseCounts.outpost)]);
    }

    return rows;
  }



  loadUiPrefs() {
    try {
      const raw = window.localStorage.getItem(UI_PREFS_STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : {};
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch (error) {
      return {};
    }
  }

  // Push the persisted UI preferences into every widget + renderer flag.
  // Runs at connect, and again after sign-in once the server copy merges.
  applyUiPrefsToUi() {
    const uiPrefs = this.loadUiPrefs();
    this.elements.watchRefreshToggle.checked = uiPrefs.watchAutoRefresh !== false;
    const validLoot = ["tier", "total", "r1", "r2", "r3", "r4"];
    this.lootResource = validLoot.includes(uiPrefs.lootResource) ? uiPrefs.lootResource : "total";
    // Both map overlays default ON: only an explicit false turns them off.
    this.toggleLootDisplay(uiPrefs.showLoot !== false);
    this.showOutpostTypes = uiPrefs.showOutpostTypes !== false;
    // Default ON: only an explicit false turns it off.
    this.showIdleWorkers = uiPrefs.showIdleWorkers !== false;
    this.renderer?.setShowIdleWorkers(this.showIdleWorkers);
    const idleToggle = document.getElementById("idle-worker-toggle");
    if (idleToggle) idleToggle.checked = this.showIdleWorkers;
    this.renderer?.setShowOutpostTypes(this.showOutpostTypes);
    const outpostToggle = document.getElementById("outpost-type-toggle");
    if (outpostToggle) outpostToggle.checked = this.showOutpostTypes;
    this.toggleLootInfo(uiPrefs.showLootInfo === true);
  }

  saveUiPref(key, value) {
    try {
      const prefs = this.loadUiPrefs();
      prefs[key] = value;
      window.localStorage.setItem(UI_PREFS_STORAGE_KEY, JSON.stringify(prefs));
      // Signed in: mirror the whole pref blob into the account settings so
      // preferences follow the user across devices.
      if (this.session && this.userSettings) {
        this.userSettings.uiPrefs = prefs;
        this.scheduleSaveUserSettings();
      }
    } catch (error) {
      console.warn("[BYM-MR2] Failed to save UI preference.", error);
    }
  }

  setNavEnabled(enabled) {
    const isEnabled = Boolean(enabled);
    // Jump is a pure client-side pan over whatever map is loaded - it
    // works signed out, and it works signed in while viewing another
    // server's cache. Never disable it.
    this.elements.jumpXInput.disabled = false;
    this.elements.jumpYInput.disabled = false;
    this.elements.jumpButton.disabled = false;
    const cachedPrefix = document.getElementById("world-cached-prefix");
    if (cachedPrefix) cachedPrefix.hidden = Boolean(isEnabled);
    if (this.elements.jumpOpenButton) this.elements.jumpOpenButton.disabled = false;
    if (this.elements.bookmarksToggleButton) this.elements.bookmarksToggleButton.disabled = false;
    if (!isEnabled) { this.closeModals(); this.hideBookmarkFlyout(); }
    this.elements.findHomeButton.disabled = false;
    // Bookmarks are per-account (any view); guests get the sign-in
    // prompt from the buttons themselves.
    this.elements.bookmarkNameInput.disabled = !this.session;
    this.elements.bookmarkAddButton.disabled = !this.session;

    this.elements.measureButton.disabled = !isEnabled;
    this.elements.scanButton.disabled = !isEnabled;
    const scanBasesButton = document.getElementById("scan-bases-button");
    if (scanBasesButton) scanBasesButton.disabled = !isEnabled;
    this.elements.watchRefreshToggle.disabled = !isEnabled;

    if (isEnabled) {
      const maxX = (this.renderer?.getMapWidth() || 800) - 1;
      const maxY = (this.renderer?.getMapHeight() || 800) - 1;
      this.elements.jumpXInput.max = String(maxX);
      this.elements.jumpYInput.max = String(maxY);
      if (this.elements.jumpStatus) this.elements.jumpStatus.textContent = `Jump to any cell (0-${maxX}, 0-${maxY}); coordinates wrap around the map edges.`;
      this.applyUiPrefsToUi();
    } else {
      if (this.elements.jumpStatus) this.elements.jumpStatus.textContent = "Sign in to jump to cells.";
      this.bookmarks = [];
      this.renderBookmarks();
      this.setMeasureActive(false);
      this.stopWatchTimer();
      this.scanRunning = false;
      this.elements.scanButton.textContent = "Scan World";
      this.elements.scanProgress.hidden = true;
      this.elements.scanStatus.textContent = "";
      this.profileOwnerId = null;
      this.watchEvents = this.createEmptyWatchEvents();
      this.renderWatchActivity();
    }
  }

  // ------------------------------------------------------------------
  // Measure tool
  // ------------------------------------------------------------------
  toggleMeasure() {
    this.setMeasureActive(!this.measureActive);
  }

  setMeasureActive(active) {
    this.measureActive = Boolean(active) && Boolean(this.session || this.isGuestView);
    this.elements.measureButton.classList.toggle("active", this.measureActive);
    this.elements.measureButton.textContent = this.measureActive ? "Stop" : "Measure";
    this.elements.measureStatus.hidden = !this.measureActive;
    if (this.measureActive) {
      this.elements.measureStatus.textContent = "Click a cell to place the first point.";
    }
    this.renderer?.setMeasureMode(this.measureActive);
  }

  updateMeasureStatus({ mode, count, draft } = {}) {
    if (!this.measureActive) {
      return;
    }

    const measurementCount = Number(count || 0);
    if (mode === "carry") {
      this.elements.measureStatus.textContent = "Point picked up - click a cell to drop it.";
    } else if (mode === "draft" && draft) {
      this.elements.measureStatus.textContent =
        `First point ${draft.x}, ${draft.y} - click the second cell.`;
    } else if (measurementCount > 0) {
      this.elements.measureStatus.textContent =
        `${formatNumber(measurementCount)} measurement${measurementCount === 1 ? "" : "s"} on the map. ` +
        "Click a point to move it, or any cell to start another.";
    } else {
      this.elements.measureStatus.textContent = "Click a cell to place the first point.";
    }
  }

  // ------------------------------------------------------------------
  // World scan
  // ------------------------------------------------------------------
  applyAdminUi() {
    if (this.elements.scanItem) {
      this.elements.scanItem.hidden = !this.isViewerAdmin;
    }
    if (this.elements.setupItem) {
      this.elements.setupItem.hidden = !this.isViewerAdmin;
    }
    const emptyNote = document.getElementById("settings-empty-note");
    if (emptyNote) emptyNote.hidden = true; // loot settings exist for everyone
  }

  async handleScanButton() {
    if (!this.session || this.isGuestView || !this.renderer || !this.isViewerAdmin) {
      return;
    }

    if (this.scanRunning) {
      this.renderer.cancelWorldScan();
      this.elements.scanStatus.textContent = "Cancelling...";
      return;
    }

    this.scanRunning = true;
    this.elements.scanButton.textContent = "Cancel Scan";
    this.elements.scanProgress.hidden = false;
    this.elements.scanProgressFill.style.width = "0%";
    this.elements.scanStatus.textContent = "Starting scan...";
    debugLog("World scan started.");

    try {
      const result = await this.renderer.startWorldScan({
        onProgress: (progress) => this.updateScanProgress(progress),
      });
      debugLog("World scan finished:", result);
      this.rebuildSearchIndex();
      this.rebuildFilterOptions(true);
      this.setSearchEnabled(
        true,
        `${formatNumber(this.searchEntries.length)} player bases indexed from explored zones.`,
      );
      if (result) {
        this.elements.scanStatus.textContent = result.cancelled
          ? `Scan cancelled at ${formatNumber(result.fetched + result.skipped)} / ${formatNumber(result.total)} zones. Progress is saved; run again to resume.`
          : `Scan complete: ${formatNumber(result.fetched)} zones fetched, ${formatNumber(result.skipped)} already fresh${result.failed ? `, ${formatNumber(result.failed)} failed` : ""}.`;
      }
    } catch (error) {
      console.error("[BYM-MR2] World scan failed:", error);
      this.elements.scanStatus.textContent = error.message || "Scan failed.";
    } finally {
      this.scanRunning = false;
      this.elements.scanButton.textContent = "Scan World";
    }
  }

  // Admin: load every explored main yard once through /base/load so the
  // server's baseloads/ archive gets one snapshot per player. Sequential
  // at LOW priority - a background crawl must never starve interactive
  // views (which run at priority 10) or the world scan.
  async handleScanBasesButton() {
    const button = document.getElementById("scan-bases-button");
    const progressBox = document.getElementById("scan-bases-progress");
    const progressFill = document.getElementById("scan-bases-progress-fill");
    const statusEl = document.getElementById("scan-bases-status");
    if (!button || !this.session) return;
    if (this.baseScanRunning) {
      this.baseScanCancel = true;
      if (statusEl) statusEl.textContent = "Cancelling...";
      return;
    }
    const mains = [];
    for (const cell of this.renderer?.cellCache?.values?.() || []) {
      if (Number(cell.b) !== MR2.yardTypes.main) continue;
      const baseid = String(cell.bid || "").trim();
      if (!baseid || baseid === "0") continue;
      mains.push({ baseid, name: String(cell.n || "").trim(), x: cell.x, y: cell.y });
    }
    if (!mains.length) {
      if (statusEl) statusEl.textContent = "No explored main yards with base ids in the cache. Run Scan World first.";
      return;
    }
    this.baseScanRunning = true;
    this.baseScanCancel = false;
    button.textContent = "Cancel Base Scan";
    if (progressBox) progressBox.hidden = false;
    if (progressFill) progressFill.style.width = "0%";
    const startedAt = Date.now();
    let done = 0;
    let failed = 0;
    const failCounts = new Map();
    try {
      // Mirrors startWorldScan's model: MR2.scanConcurrency workers pulling
      // from a shared queue, paced by the proxy budget alone instead of a
      // self-imposed spacing floor. Runs at top priority (10) by operator
      // choice: scans are admin-initiated maintenance and the admin bypass
      // usually covers them anyway. The old crawl
      // also paid a full zone reload before EVERY base load to dodge stale
      // base ids; now the cached id is tried first and the zone refresh
      // runs only on failure - one upstream call per base in the common
      // case, and co-zoned mains share any refresh that does happen.
      const refreshedZones = new Map();
      const refreshZoneOnce = (main) => {
        const zone = {
          x: Math.floor(main.x / MR2.zoneSize) * MR2.zoneSize,
          y: Math.floor(main.y / MR2.zoneSize) * MR2.zoneSize,
        };
        const key = `${zone.x},${zone.y}`;
        if (!refreshedZones.has(key)) {
          refreshedZones.set(
            key,
            this.renderer?.reloadZoneNow(zone, BASE_SCAN_PRIORITY) || Promise.resolve());
        }
        return refreshedZones.get(key);
      };
      const loadBase = (baseid, token) => fetchJson(buildBymUrl("/base/load"), {
        method: "POST",
        headers: {
          "X-Fetch-Priority": String(BASE_SCAN_PRIORITY),
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
        },
        body: new URLSearchParams({
          type: "view",
          baseid,
          userid: String(this.session?.user?.userid ?? 0),
          mapversion: "2",
        }),
      });
      // One load attempt with stale-token recovery (recoverSessionToken is
      // single-flight, so concurrent workers share one rotation).
      const attemptWithAuth = async (baseid) => {
        try {
          await loadBase(baseid, this.session?.token || "");
        } catch (error) {
          const status = Number(error?.status);
          if (status !== 401 && status !== 403) throw error;
          const fresh = String((await this.recoverSessionToken()) || "").trim();
          if (!fresh) throw error;
          await loadBase(baseid, fresh);
        }
      };
      const updateStatus = () => {
        const percent = Math.floor((done / mains.length) * 100);
        if (progressFill) progressFill.style.width = `${percent}%`;
        if (!statusEl) return;
        const elapsed = Date.now() - startedAt;
        const remainingMin = done >= 1
          ? Math.ceil(((elapsed / done) * (mains.length - done)) / 60000)
          : null;
        const codeBits = failed
          ? ` (${[...failCounts.entries()].map(([c, n]) => `${c}:${n}`).join(", ")})`
          : "";
        statusEl.textContent =
          `${formatNumber(done)} / ${formatNumber(mains.length)} bases`
          + `${failed ? `, ${formatNumber(failed)} failed${codeBits}` : ""}`
          + (remainingMin && done < mains.length ? ` — about ${remainingMin} min left` : "");
      };
      let nextIndex = 0;
      const worker = async () => {
        while (!this.baseScanCancel) {
          const index = nextIndex;
          nextIndex += 1;
          if (index >= mains.length) return;
          const main = mains[index];
          try {
            try {
              await attemptWithAuth(main.baseid);
            } catch (firstError) {
              // Likely a stale base id (player relocated or saved since the
              // cache snapshot): refresh the zone, re-read the id, retry.
              await refreshZoneOnce(main).catch(() => {});
              const fresh = this.renderer?.cellCache?.get(cellKey(main.x, main.y));
              const freshId = String(fresh?.bid || "").trim();
              if (!freshId || freshId === main.baseid) throw firstError;
              await attemptWithAuth(freshId);
            }
          } catch (error) {
            failed += 1;
            const status = Number(error?.status) || "network";
            failCounts.set(status, (failCounts.get(status) || 0) + 1);
            console.error(`[BYM-MR2] Base scan FAILED for "${main.name || "?"}"`, {
              cachedBaseId: main.baseid,
              cell: { x: main.x, y: main.y },
              httpStatus: Number(error?.status) || null,
              errorName: error?.name,
              errorMessage: error?.message,
              errorPayload: error?.payload ?? null,
            });
          }
          done += 1;
          updateStatus();
        }
      };
      await Promise.all(Array.from({ length: MR2.scanConcurrency }, () => worker()));
      if (statusEl) {
        const failBits = failed
          ? ` (${[...failCounts.entries()].map(([code, n]) => `${code}: ${n}`).join(", ")})`
          : "";
        statusEl.textContent = this.baseScanCancel
          ? `Base scan cancelled at ${formatNumber(done)} / ${formatNumber(mains.length)}.`
          : `Base scan complete: ${formatNumber(done - failed)} archived${failed ? `, ${formatNumber(failed)} failed${failBits}` : ""}.`;
      }
    } finally {
      this.baseScanRunning = false;
      this.baseScanCancel = false;
      button.textContent = "Scan Bases";
    }
  }

  updateScanProgress(progress) {
    const percent = progress.total ? Math.floor((progress.completed / progress.total) * 100) : 0;
    this.elements.scanProgressFill.style.width = `${percent}%`;

    const elapsedMs = Date.now() - progress.startedAt;
    const rate = progress.completed > 0 ? elapsedMs / progress.completed : 0;
    const remainingMs = rate * (progress.total - progress.completed);
    const remainingMin = Math.ceil(remainingMs / 60000);
    const eta = progress.completed > 20 && progress.completed < progress.total
      ? ` — about ${remainingMin} min left`
      : "";

    this.elements.scanStatus.textContent =
      `${formatNumber(progress.completed)} / ${formatNumber(progress.total)} zones (${percent}%)` +
      `${progress.skipped ? `, ${formatNumber(progress.skipped)} fresh skipped` : ""}` +
      `${progress.failed ? `, ${formatNumber(progress.failed)} failed` : ""}${eta}`;
  }

  // ------------------------------------------------------------------
  // Watchlist auto-refresh + captured/lost activity
  // ------------------------------------------------------------------
  createEmptyWatchEvents() {
    // One flat, newest-first list. kind: "captured" | "lost" (outposts) or
    // "moved" (main yards; fromX/fromY and/or x/y depending on what was
    // observed).
    return { activity: [] };
  }

  loadWatchEvents() {
    this.watchEvents = this.createEmptyWatchEvents();
    const stored = this.userSettings?.watchEvents?.[this.getWorldSettingsKey()] || null;
    if (Array.isArray(stored?.activity)) {
      this.watchEvents.activity = stored.activity.slice(0, MR2.watchEventListLimit);
    } else if (stored && typeof stored === "object") {
      // Legacy shape: { allies: { captured: [...], lost: [...] } }. Merge
      // both lists into the flat feed, tagging each with its old kind.
      const merged = [];
      for (const kind of ["captured", "lost"]) {
        for (const event of stored?.allies?.[kind] || []) {
          if (event && typeof event === "object") {
            merged.push({ ...event, kind });
          }
        }
      }
      merged.sort((left, right) => Number(right.at || 0) - Number(left.at || 0));
      this.watchEvents.activity = merged.slice(0, MR2.watchEventListLimit);
    }
    this.renderWatchActivity();
  }

  saveWatchEvents() {
    if (!this.session || !this.userSettings) {
      return;
    }

    this.userSettings.watchEvents[this.getWorldSettingsKey()] = this.watchEvents;
    this.scheduleSaveUserSettings();
  }

  clearWatchEvents() {
    this.watchEvents = this.createEmptyWatchEvents();
    this.saveWatchEvents();
    this.renderWatchActivity();
  }

  getWatchedNameSets() {
    // Watched = the signed-in player plus their alliance members: the
    // Activity feed covers outposts you and your allies take or lose, and
    // your/their main yard moves. (collectAllyZoneOrigins caps how many
    // zones the refresh cycle actually touches, so a big alliance cannot
    // blow the API budget.)
    const allies = new Set();
    const ownName = String(this.session?.user?.username || "").trim().toLocaleLowerCase();
    if (ownName) {
      allies.add(ownName);
    }
    for (const member of this.allianceMemberNames || []) {
      const name = String(member || "").trim().toLocaleLowerCase();
      if (name) {
        allies.add(name);
      }
    }
    return { allies };
  }

  // Called by the renderer whenever a merged zone shows an ownership change.
  recordWatchEvents(changes) {
    if (!this.session || !Array.isArray(changes) || !changes.length) {
      return;
    }

    const watched = this.getWatchedNameSets();

    if (!watched.allies.size) {
      this.reportAllianceFeedEvents(changes);
      return;
    }

    let recorded = 0;
    const toNotify = [];
    const describe = (cell) => {
      const name = String(cell?.n || "").trim();
      if (Number(cell?.uid || 0) > 0 && name) return name;
      if (Number(cell?.b) === MR2.yardTypes.wildMonster) return "wild monsters";
      return "unknown";
    };
    const record = (event, body) => {
      this.pushWatchEvent(event);
      toNotify.push({ body, x: event.x ?? event.fromX, y: event.y ?? event.fromY });
      recorded += 1;
    };

    // Main-yard changes are movement, not capture: mains only ever change
    // cell when their owner relocates. Collect them per player so a
    // disappearance and an appearance observed in the same batch pair into
    // one "moved from A to B" event.
    const mainGains = new Map();
    const mainLosses = new Map();

    for (const change of changes) {
      const prevName = String(change.previous?.n || "").trim().toLocaleLowerCase();
      const currName = String(change.current?.n || "").trim().toLocaleLowerCase();
      const prevOwned = Number(change.previous?.uid || 0) > 0;
      const currOwned = Number(change.current?.uid || 0) > 0;
      const prevIsMain = prevOwned && Number(change.previous?.b) === MR2.yardTypes.main;
      const currIsMain = currOwned && Number(change.current?.b) === MR2.yardTypes.main;

      // Watched main yard appeared where it was not before. Not a continue:
      // the same cell change can also carry the previous owner's outpost
      // loss, which must still record below.
      if (currIsMain && watched.allies.has(currName) && (!prevOwned || prevName !== currName)) {
        if (!this.isPlayerHidden(change.current?.n)) {
          mainGains.set(currName, {
            playerName: String(change.current.n).trim(),
            x: change.x,
            y: change.y,
            level: Number(change.current.l || 0),
          });
        }
      }

      // Watched main yard no longer at this cell.
      if (prevIsMain && watched.allies.has(prevName) && (!currOwned || currName !== prevName)) {
        if (!this.isPlayerHidden(change.previous?.n)) {
          mainLosses.set(prevName, {
            playerName: String(change.previous.n).trim(),
            x: change.x,
            y: change.y,
          });
        }
      }

      // Captured: a watched player now owns an outpost cell they did not
      // own before. Mains are movement, handled above.
      if (currOwned && !currIsMain && watched.allies.has(currName) && (!prevOwned || prevName !== currName)) {
        if (this.isPlayerHidden(change.current?.n) || this.isPlayerHidden(describe(change.previous))) {
          continue;
        }
        record({
          kind: "captured",
          playerName: String(change.current.n).trim(),
          x: change.x,
          y: change.y,
          cellType: "outpost",
          level: Number(change.current.l || 0),
          otherParty: describe(change.previous),
          at: Date.now(),
        }, `${String(change.current.n).trim()} captured an outpost at ${change.x}, ${change.y} from ${describe(change.previous)}`);
      }

      // Lost: a watched player owned this outpost before and no longer does.
      if (prevOwned && !prevIsMain && watched.allies.has(prevName) && (!currOwned || currName !== prevName)) {
        // Same rule as the captured branch: if either party is hidden, the
        // event must not surface - otherwise a hidden player capturing an
        // ally's outpost leaks by name via "lost ... to <capturer>".
        if (this.isPlayerHidden(change.previous?.n) || this.isPlayerHidden(describe(change.current))) {
          continue;
        }
        record({
          kind: "lost",
          playerName: String(change.previous.n).trim(),
          x: change.x,
          y: change.y,
          cellType: "outpost",
          level: Number(change.previous.l || 0),
          otherParty: describe(change.current),
          at: Date.now(),
        }, `${String(change.previous.n).trim()} lost an outpost at ${change.x}, ${change.y} to ${describe(change.current)}`);
      }
    }

    // Pair main losses and gains into moves; unpaired halves are still
    // movement, just with only one end observed (the other end may be in a
    // zone this batch did not cover).
    for (const [name, gain] of mainGains) {
      const loss = mainLosses.get(name) || null;
      mainLosses.delete(name);
      record({
        kind: "moved",
        playerName: gain.playerName,
        x: gain.x,
        y: gain.y,
        fromX: loss ? loss.x : null,
        fromY: loss ? loss.y : null,
        cellType: "main yard",
        level: gain.level,
        at: Date.now(),
      }, loss
        ? `${gain.playerName} moved their main yard from ${loss.x}, ${loss.y} to ${gain.x}, ${gain.y}`
        : `${gain.playerName} moved their main yard to ${gain.x}, ${gain.y}`);
    }
    for (const [, loss] of mainLosses) {
      record({
        kind: "moved",
        playerName: loss.playerName,
        x: null,
        y: null,
        fromX: loss.x,
        fromY: loss.y,
        cellType: "main yard",
        at: Date.now(),
      }, `${loss.playerName}'s main yard moved away from ${loss.x}, ${loss.y}`);
    }

    this.reportAllianceFeedEvents(changes);

    if (recorded > 0) {
      debugLog(`Activity recorded ${recorded} event(s).`);
      this.saveWatchEvents();
      this.renderWatchActivity();
      this.notifyWatchEvents(toNotify);
    }
  }

  // Feed reporting: any ownership change involving an ally or an alliance
  // enemy is posted to the shared alliance feed. Purely passive - it only
  // inspects changes already observed during normal zone refetches - and
  // the server deduplicates across members.
  reportAllianceFeedEvents(changes) {
    if (!this.alliance || !Array.isArray(changes) || !changes.length) {
      return;
    }
    const watched = this.getWatchedNameSets();
    const enemies = new Set(
      [...this.allianceEnemyNames].map((name) => String(name).trim().toLocaleLowerCase()),
    );
    const involved = (name) => watched.allies.has(name) || enemies.has(name);
    const world = String(this.reportWorldOverride || this.session?.map?.worldid || "");
    const describe = (cell) => {
      const name = String(cell?.n || "").trim();
      if (Number(cell?.uid || 0) > 0 && name) return name;
      if (Number(cell?.b) === MR2.yardTypes.wildMonster) return "wild monsters";
      return "unknown";
    };
    const events = [];
    for (const change of changes) {
      const prevName = String(change.previous?.n || "").trim();
      const currName = String(change.current?.n || "").trim();
      const prevOwned = Number(change.previous?.uid || 0) > 0;
      const currOwned = Number(change.current?.uid || 0) > 0;
      if (this.isPlayerHidden(prevName) || this.isPlayerHidden(currName)) {
        continue;
      }
      if (currOwned && involved(currName.toLocaleLowerCase()) &&
          (!prevOwned || prevName.toLocaleLowerCase() !== currName.toLocaleLowerCase())) {
        events.push({
          kind: "captured",
          playerName: currName,
          x: change.x, y: change.y, world,
          cellType: Number(change.current.b) === MR2.yardTypes.main ? "main yard" : "outpost",
          level: Number(change.current.l || 0),
          otherParty: describe(change.previous),
          at: Date.now(),
        });
      }
      if (prevOwned && involved(prevName.toLocaleLowerCase()) &&
          (!currOwned || currName.toLocaleLowerCase() !== prevName.toLocaleLowerCase())) {
        events.push({
          kind: "lost",
          playerName: prevName,
          x: change.x, y: change.y, world,
          cellType: Number(change.previous.b) === MR2.yardTypes.main ? "main yard" : "outpost",
          level: Number(change.previous.l || 0),
          otherParty: describe(change.current),
          at: Date.now(),
        });
      }
    }
    if (events.length) {
      alliancePost("feed", { events: events.slice(0, 20) })
        .then((payload) => this.adoptRefreshedToken(payload?.token))
        .catch((error) => debugLog("Alliance feed report failed.", error));
    }
  }

  pushWatchEvent(event) {
    const list = this.watchEvents.activity;
    list.unshift(event);
    if (list.length > MR2.watchEventListLimit) {
      list.length = MR2.watchEventListLimit;
    }
  }

  // Browser notifications for watch events, so captures and losses reach the
  // player without the tab in focus. Requires the permission granted when
  // the watch toggle was enabled; capped per batch so a busy refresh cycle
  // cannot spam the OS notification tray.
  notifyWatchEvents(events) {
    if (
      !Array.isArray(events) ||
      !events.length ||
      !("Notification" in window) ||
      window.Notification.permission !== "granted"
    ) {
      return;
    }

    const shown = events.slice(0, 3);
    for (const event of shown) {
      try {
        const notification = new window.Notification("BYM MR2 Viewer", {
          body: event.body,
          tag: `bym-watch-${event.x}-${event.y}`,
        });
        notification.onclick = () => {
          window.focus();
          this.jumpToAllianceYard({ world: event.world || "", main: { x: event.x, y: event.y } })
            .catch(() => this.renderer?.jumpToCoordinates(event.x, event.y));
          notification.close();
        };
      } catch (error) {
        debugLog("Notification failed.", error);
        return;
      }
    }
    if (events.length > shown.length) {
      try {
        const extra = new window.Notification("BYM MR2 Viewer", {
          body: `...and ${events.length - shown.length} more watchlist event(s).`,
          tag: "bym-watch-overflow",
        });
        extra.onclick = () => window.focus();
      } catch (error) {
        void error;
      }
    }
  }

  setActivityTab(tab) {
    if (!this.session && String(tab) !== "server") {
      // Guests only get the Server feed; other scopes prompt sign-in.
      this.openAccountModal();
      tab = "server";
    }
    let key = String(tab || "me");
    if (key === "global") key = "me";   // tab removed; old prefs land on Me
    if (!["me", "allies", "enemies", "server"].includes(key)) {
      return;
    }
    this.activityTab = key;
    for (const button of document.querySelectorAll("[data-activity-tab]")) {
      const active = button.dataset.activityTab === key;
      button.classList.toggle("active", active);
      button.setAttribute("aria-selected", String(active));
    }
    this.renderWatchActivity();
  }

  // Scope filter for one change record against the current tab. Names are
  // matched case-insensitively on either side of the takeover.
  activityRecordMatchesTab(record, tab, names) {
    const newName = record.newName.toLocaleLowerCase();
    const prevName = record.prevName.toLocaleLowerCase();
    if (tab === "me") {
      return Boolean(names.own) && (newName === names.own || prevName === names.own);
    }
    if (tab === "allies") {
      return names.allies.has(newName) || names.allies.has(prevName);
    }
    if (tab === "enemies") {
      return names.enemies.has(newName) || names.enemies.has(prevName);
    }
    return true; // server / global
  }

  describeChangeRecord(record) {
    const typeName = (type) => {
      if (type === MR2.yardTypes.main) return "a main yard";
      if (type === MR2.yardTypes.outpost) return "an outpost";
      if (type === MR2.yardTypes.wildMonster) return "a wild base";
      return "a base";
    };
    const prevDesc = record.prevUid > 0
      ? (record.prevName || "unknown")
      : (record.prevType === MR2.yardTypes.wildMonster ? "wild monsters" : (record.prevName || "wild monsters"));

    if (record.newUid > 0) {
      // Someone owns it now: a capture (from a player, or claimed from wild).
      return {
        actor: record.newName || "Unknown",
        action: `captured ${typeName(record.newType)} at ${record.x}, ${record.y} from ${escapeHtml(prevDesc)}`,
      };
    }
    // Nobody owns it now: the previous owner lost it back to the wild.
    return {
      actor: record.prevName || "Unknown",
      action: `lost ${typeName(record.prevType)} at ${record.x}, ${record.y} (now wild)`,
    };
  }

  renderWatchActivity() {
    const container = this.elements.activityList;
    if (!container) {
      return;
    }

    const tab = this.activityTab;
    if (tab === "global") {
      this.renderGlobalActivity(container);
      return;
    }

    container.replaceChildren();
    if (!this.session && !this.isGuestView) {
      container.innerHTML = '<span class="watch-empty">Sign in (or open a cached world) to see activity.</span>';
      return;
    }

    const names = {
      own: String(this.session?.user?.username || "").trim().toLocaleLowerCase(),
      allies: new Set([...(this.allianceMemberNames || [])]
        .map((name) => String(name).trim().toLocaleLowerCase()).filter(Boolean)),
      enemies: new Set([...(this.allianceEnemyNames || [])]
        .map((name) => String(name).trim().toLocaleLowerCase()).filter(Boolean)),
    };

    if (tab === "me" && !names.own) {
      container.innerHTML = '<span class="watch-empty">Sign in to see your own activity.</span>';
      return;
    }
    if ((tab === "allies" || tab === "enemies") && !this.alliance) {
      container.innerHTML = '<span class="watch-empty">Join an alliance to scope activity to allies and enemies.</span>';
      return;
    }

    const records = (this.renderer?.getRecentChangeRecords(500) || [])
      .filter((record) => !this.isPlayerHidden(record.newName) && !this.isPlayerHidden(record.prevName))
      .filter((record) => this.activityRecordMatchesTab(record, tab, names));

    this.renderActivityRecords(container, records);
  }

  renderActivityRecords(container, records, { showWorld = false } = {}) {
    container.replaceChildren();
    if (!records.length) {
      container.innerHTML = '<span class="watch-empty">No recent changes observed.</span>';
      return;
    }

    for (const record of records.slice(0, 50)) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "watch-event";
      const { actor, action } = this.describeChangeRecord(record);
      const worldTag = showWorld && record.world
        ? ` <span class="watch-world">${escapeHtml(this.worldNameById?.get(String(record.world)) || String(record.world))}</span>`
        : "";
      button.innerHTML = `<strong class="${this.nameRelationClass(actor)}">${escapeHtml(actor)}</strong> ${action}${worldTag} <span class="watch-time">${escapeHtml(formatRelativeTime(record.at))}</span>`;

      const sameWorld = !record.world ||
        String(record.world) === String(this.renderer?.serverName || "");
      if (sameWorld) {
        button.title = `Jump to ${record.x}, ${record.y}`;
        button.addEventListener("click", () => {
          this.renderer?.jumpToCoordinates(Number(record.x), Number(record.y));
        });
      } else {
        button.title = "View that world (from the Worlds menu) to jump to this cell";
        button.disabled = true;
      }
      container.appendChild(button);
    }
  }

  renderGlobalActivity(container) {
    const cacheFresh = Date.now() - this.globalActivity.fetchedAt < MR2.activityGlobalCacheMs;
    if (cacheFresh) {
      this.renderActivityRecords(container, this.globalActivity.records, { showWorld: true });
      return;
    }
    if (!this.globalActivity.loading) {
      this.globalActivity.loading = true;
      fetchWorldChanges({ limit: 100 })
        .then((payload) => {
          this.globalActivity.records = Array.isArray(payload?.changes) ? payload.changes : [];
          this.globalActivity.fetchedAt = Date.now();
        })
        .catch((error) => {
          debugLog("Global activity fetch failed.", error);
          this.globalActivity.records = [];
          this.globalActivity.fetchedAt = Date.now() - MR2.activityGlobalCacheMs + 30_000;
        })
        .finally(() => {
          this.globalActivity.loading = false;
          if (this.activityTab === "global") {
            this.renderActivityRecords(this.elements.activityList, this.globalActivity.records, { showWorld: true });
          }
        });
    }
    container.replaceChildren();
    container.innerHTML = '<span class="watch-empty">Loading global activity...</span>';
  }

  handleWatchToggle() {
    this.saveUiPref("watchAutoRefresh", this.elements.watchRefreshToggle.checked);
    if (
      this.elements.watchRefreshToggle.checked &&
      "Notification" in window &&
      window.Notification.permission === "default"
    ) {
      // Ask once, when the user opts into watching; denial is respected.
      window.Notification.requestPermission().catch(() => {});
    }
    this.syncWatchTimer();
  }

  syncWatchTimer() {
    this.stopWatchTimer();
    if (!this.session || !this.elements.watchRefreshToggle.checked) {
      return;
    }

    const runCycle = (mode) => {
      this.runWatchCycle(mode).catch((error) => {
        console.warn("[BYM-MR2] Watchlist refresh failed.", error);
      });
    };
    // Cached checks (shared cache only, no game traffic) every 10 minutes,
    // first one a minute after arming; a LIVE burst against the game API
    // only once per hour, so the game still sees the player offline.
    this.watchInitialTimer = window.setTimeout(() => runCycle("cached"), 60 * 1000);
    this.watchCachedTimer = window.setInterval(() => runCycle("cached"), MR2.watchCachedIntervalMs);
    this.watchTimer = window.setInterval(() => runCycle("live"), MR2.watchRefreshIntervalMs);
    // Your own zones (main yard + outposts) refresh live every 5 minutes -
    // a handful of zones, and the calls double as the session keepalive.
    this.watchOwnTimer = window.setInterval(() => runCycle("own"), MR2.watchOwnRefreshIntervalMs);
    // Correction to an old assumption: the game does NOT expire idle
    // sessions (no redis TTL, 30d JWT - see MR2.sessionKeepaliveIdleMs).
    // The rare idle rotation below exists only to DETECT a token that
    // something else invalidated (the game client and the viewer share one
    // GAME-token slot, and whoever logs in last owns it) - not to keep an
    // idle session alive, which needs no help.
    this.keepaliveTimer = window.setInterval(() => {
      this.runSessionKeepalive().catch((error) => {
        debugLog("Session keepalive failed.", error);
      });
    }, MR2.sessionKeepaliveCheckMs);

    debugLog("Activity armed: cached checks every 10 min, live burst hourly, keepalive on idle.");
  }

  async runSessionKeepalive() {
    if (!this.session || this.isGuestView || this.scanRunning) {
      return;
    }
    if (Date.now() - this.lastTokenTouchAt < MR2.sessionKeepaliveIdleMs) {
      return;
    }
    const token = await this.recoverSessionToken();
    if (token) {
      this.lastTokenTouchAt = Date.now();
      this.setActivityStatus("");
    } else {
      // Do NOT latch the whole viewer into the expired state from a
      // background timer; say so in the Activity menu and let cached checks
      // keep running (they never touch the game).
      this.setActivityStatus(
        "Your game session could not be kept alive. Live checks are paused - sign in again to resume them. Cached checks continue.",
      );
    }
  }

  setActivityStatus(message) {
    const el = this.elements.activityStatus;
    if (!el) {
      return;
    }
    el.hidden = !message;
    el.textContent = message || "";
  }

  stopWatchTimer() {
    if (this.watchInitialTimer) {
      window.clearTimeout(this.watchInitialTimer);
      this.watchInitialTimer = 0;
    }
    if (this.watchCachedTimer) {
      window.clearInterval(this.watchCachedTimer);
      this.watchCachedTimer = 0;
    }
    if (this.watchTimer) {
      window.clearInterval(this.watchTimer);
      this.watchTimer = 0;
    }
    if (this.watchOwnTimer) {
      window.clearInterval(this.watchOwnTimer);
      this.watchOwnTimer = 0;
    }
    if (this.keepaliveTimer) {
      window.clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = 0;
    }
  }

  // Independent of the Activity toggle: armed on connect, cleared on
  // sign-out, so the hourly leaderboard stays fresh even with watch off.
  startLeaderboardAutoRefresh() {
    this.stopLeaderboardAutoRefresh();
    this.leaderboardRefreshTimer = window.setInterval(() => {
      this.refreshLeaderboardHourly().catch((error) => {
        debugLog("Hourly leaderboard refresh failed.", error);
      });
    }, 60 * 60 * 1000);
  }

  stopLeaderboardAutoRefresh() {
    if (this.leaderboardRefreshTimer) {
      window.clearInterval(this.leaderboardRefreshTimer);
      this.leaderboardRefreshTimer = 0;
    }
  }

  async refreshLeaderboardHourly() {
    const worldId = String(this.session?.map?.worldid || "").trim();
    if (!worldId || !this.session || this.isGuestView) return;
    this.leaderboardCache.delete(worldId);
    await this.getLeaderboardRows(worldId);
    // Re-render only if the panel is actually open on this world; a closed
    // panel just picks up the fresh cache next time it opens.
    const panel = document.getElementById("dock-leaderboard-panel");
    if (panel && !panel.hidden) {
      await this.loadLeaderboard(worldId);
    }
  }

  // Zones containing cells owned by the signed-in player only - the 5-minute
  // live refresh covers just your own main yard and outposts.
  // Every zone in `origins` plus its 8 neighbouring zones (torus-wrapped),
  // capped. The ring catches bases that sit just across a zone boundary
  // and territory shifts around the watched area.
  expandZoneRing(origins, limit) {
    const mapW = this.renderer?.getMapWidth?.() || 800;
    const mapH = this.renderer?.getMapHeight?.() || 800;
    const step = MR2.zoneSize;
    const out = new Map();
    for (const origin of origins) {
      for (let dx = -1; dx <= 1; dx += 1) {
        for (let dy = -1; dy <= 1; dy += 1) {
          const zx = ((origin.x + dx * step) % mapW + mapW) % mapW;
          const zy = ((origin.y + dy * step) % mapH + mapH) % mapH;
          out.set(`${zx},${zy}`, { x: zx, y: zy });
          if (out.size >= limit) return [...out.values()];
        }
      }
    }
    return [...out.values()];
  }

  collectOwnZoneOrigins(limit) {
    if (!this.renderer) {
      return [];
    }
    const ownName = String(this.session?.user?.username || "").trim().toLocaleLowerCase();
    if (!ownName) {
      return [];
    }
    const zoneOrigins = new Map();
    for (const cell of this.renderer.cellCache.values()) {
      const name = String(cell.n || "").trim().toLocaleLowerCase();
      if (name !== ownName || Number(cell.uid || 0) <= 0) {
        continue;
      }
      const zx = Math.floor(cell.x / MR2.zoneSize) * MR2.zoneSize;
      const zy = Math.floor(cell.y / MR2.zoneSize) * MR2.zoneSize;
      zoneOrigins.set(`${zx},${zy}`, { x: zx, y: zy });
      if (zoneOrigins.size >= limit) {
        break;
      }
    }
    return this.expandZoneRing(zoneOrigins.values(), limit);
  }

  // Zones containing any cell owned by the signed-in player or an alliance
  // member, capped at `limit`. Used by the watch cycle.
  collectAllyZoneOrigins(limit) {
    if (!this.renderer) {
      return [];
    }
    const watched = this.getWatchedNameSets();
    if (!watched.allies.size) {
      return [];
    }
    const zoneOrigins = new Map();
    for (const cell of this.renderer.cellCache.values()) {
      const name = String(cell.n || "").trim().toLocaleLowerCase();
      if (!name || Number(cell.uid || 0) <= 0 || !watched.allies.has(name)) {
        continue;
      }
      const zx = Math.floor(cell.x / MR2.zoneSize) * MR2.zoneSize;
      const zy = Math.floor(cell.y / MR2.zoneSize) * MR2.zoneSize;
      zoneOrigins.set(`${zx},${zy}`, { x: zx, y: zy });
      if (zoneOrigins.size >= limit) {
        break;
      }
    }
    return this.expandZoneRing(zoneOrigins.values(), limit);
  }

  // ---- Automatic baseload capture on live zone ingest ----
  // Whenever a live getarea lands, any main yard in it whose baseload
  // archive is missing (priority 5) or older than 24h (priority 1) is
  // queued for a /base/load so the server refreshes baseloads/{uid}.json.
  // World scans are excluded - Scan Bases owns bulk collection.
  async ensureBaseloadFreshness() {
    const now = Date.now();
    if (this.baseloadFreshness && now - (this.baseloadFreshnessAt || 0) < 10 * 60 * 1000) {
      return this.baseloadFreshness;
    }
    try {
      const payload = await fetchJson("/api/baseload-freshness");
      this.baseloadFreshness = new Map(Object.entries(payload?.uids || {})
        .map(([uid, ms]) => [String(uid), Number(ms) || 0]));
    } catch {
      this.baseloadFreshness = this.baseloadFreshness || new Map();
    }
    this.baseloadFreshnessAt = now;
    return this.baseloadFreshness;
  }

  handleZoneLoaded(cells) {
    if (!this.session || this.isGuestView || this.scanRunning || this.baseScanRunning) return;
    const mains = cells.filter((cell) =>
      Number(cell.b) === MR2.yardTypes.main
      && Number(cell.uid || 0) > 0
      && String(cell.bid || "").trim()
      && String(cell.bid) !== "0");
    if (!mains.length) return;
    this.autoBaseloadQueue = this.autoBaseloadQueue || new Map();
    this.ensureBaseloadFreshness().then((freshness) => {
      const dayMs = 24 * 60 * 60 * 1000;
      const now = Date.now();
      for (const cell of mains) {
        const uid = String(cell.uid);
        if (this.autoBaseloadQueue.has(uid)) continue;
        const fetchedAt = freshness.get(uid) || 0;
        if (now - fetchedAt < dayMs) continue;
        this.autoBaseloadQueue.set(uid, {
          uid,
          baseid: String(cell.bid),
          name: String(cell.n || "").trim(),
          // Never captured -> worth a bit of urgency; refresh -> lowest.
          priority: fetchedAt ? 1 : 5,
        });
      }
      this.drainBaseloadQueue();
    });
  }

  async drainBaseloadQueue() {
    if (this.baseloadDrainRunning) return;
    this.baseloadDrainRunning = true;
    try {
      while (this.autoBaseloadQueue?.size) {
        if (!this.session || this.isGuestView || this.scanRunning || this.baseScanRunning) break;
        const [uid, job] = this.autoBaseloadQueue.entries().next().value;
        this.autoBaseloadQueue.delete(uid);
        const attempt = (token) => fetchJson(buildBymUrl("/base/load"), {
          method: "POST",
          headers: {
            "X-Fetch-Priority": String(job.priority),
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
          },
          body: new URLSearchParams({
            type: "view",
            baseid: job.baseid,
            userid: String(this.session?.user?.userid ?? 0),
            mapversion: "2",
          }),
        });
        try {
          try {
            await attempt(this.session?.token || "");
          } catch (error) {
            const status = Number(error?.status);
            if (status !== 401 && status !== 403) throw error;
            const fresh = String((await this.recoverSessionToken()) || "").trim();
            if (!fresh) throw error;
            await attempt(fresh);
          }
          this.baseloadFreshness?.set(uid, Date.now());
          debugLog(`Auto baseload archived: ${job.name || uid}`);
        } catch (error) {
          debugLog(`Auto baseload failed: ${job.name || uid}`, error);
        }
      }
    } finally {
      this.baseloadDrainRunning = false;
    }
  }

  async runWatchCycle(mode = "live") {
    if (!this.session || this.isGuestView || !this.renderer || this.watchCycleInFlight || this.scanRunning) {
      return;
    }

    const origins = mode === "own"
      ? this.collectOwnZoneOrigins(MR2.watchMaxZonesPerCycle)
      : this.collectAllyZoneOrigins(MR2.watchMaxZonesPerCycle);
    if (!origins.length) {
      return;
    }

    this.watchCycleInFlight = true;
    try {
      if (mode === "cached") {
        // Shared-cache read only: picks up other players' observations of
        // your zones without a single game API call. Cross-world checks were
        // dropped along with ally-watching: your own bases can only exist on
        // the world you are signed into.
        await this.renderer.refreshZonesFromSharedCache(origins);
      } else {
        // "own" and "live" modes both hit the game. If the token has idled
        // since it was last touched, rotate it first: a burst on a dead
        // token would 401 per zone and end in the full-screen "session
        // expired" overlay - fired from a background timer the player never
        // sees coming. If recovery fails, fall back to a cached pass and
        // say so in the Activity menu.
        if (Date.now() - this.lastTokenTouchAt >= MR2.sessionKeepaliveIdleMs) {
          const token = await this.recoverSessionToken();
          if (!token) {
            this.setActivityStatus(
              "Live check skipped - your game session has expired. Sign in again to resume live checks. Cached checks continue.",
            );
            await this.renderer.refreshZonesFromSharedCache(origins);
            return;
          }
          this.lastTokenTouchAt = Date.now();
        }
        debugLog(`Activity ${mode.toUpperCase()} refresh: re-fetching ${origins.length} zone(s).`);
        await this.renderer.refetchZones(origins);
        this.lastTokenTouchAt = Date.now();
        this.setActivityStatus("");
      }
      this.renderWatchActivity();
    } finally {
      this.watchCycleInFlight = false;
    }
  }

  // JumpToCoordinate, verbatim: parse both fields as Numbers; NaN gets a
  // "not a number" toast, off-map gets its own (with the game's quirk of
  // x < width but y <= height), and a valid pair jumps and closes.
  handleJump() {
    const xs = this.elements.jumpXInput.value;
    const ys = this.elements.jumpYInput.value;
    const xn = Number(xs);
    const yn = Number(ys);
    if (xs.trim() === "" || ys.trim() === "" || Number.isNaN(xn) || Number.isNaN(yn)) {
      this.showGameToast("That is not a number.");
      return;
    }
    const x = Math.trunc(xn);
    const y = Math.trunc(yn);
    const w = this.renderer?.mapWidth || 800;
    const h = this.renderer?.mapHeight || 800;
    if (!(x >= 0 && x < w && y >= 0 && y <= h)) {
      this.showGameToast("That location is off the map.");
      return;
    }
    this.closeModals();
    this.renderer?.jumpToCoordinates(x, y);
  }

  openJumpModal() {
    this.closeToolbarMenus?.();
    this.hideBookmarkFlyout();
    this.elements.jumpXInput.value = "";
    this.elements.jumpYInput.value = "";
    if (this.elements.modalBlocker) this.elements.modalBlocker.hidden = false;
    if (this.elements.jumpModal) this.elements.jumpModal.hidden = false;
    this.elements.jumpXInput.disabled = false;
    this.elements.jumpYInput.disabled = false;
    this.elements.jumpButton.disabled = false;
    this.elements.jumpXInput.focus();
  }

  openBookmarkAddModal(cell) {
    this.hideBookmarkFlyout();
    this.pendingBookmarkTarget = { x: Number(cell.x), y: Number(cell.y) };
    const owner = String(cell.n || "").trim();
    // PopupNewBookmark prefills the name with the yard owner
    // (KEYS map_yardowner); coordinates stand in for wilds.
    this.elements.bookmarkNameInput.value =
      owner ? `${owner}'s Yard` : `${cell.x}, ${cell.y}`;

    if (this.elements.modalBlocker) this.elements.modalBlocker.hidden = false;
    if (this.elements.bookmarkAddModal) this.elements.bookmarkAddModal.hidden = false;
    this.elements.bookmarkNameInput.disabled = false;
    this.elements.bookmarkAddButton.disabled = false;
    this.elements.bookmarkNameInput.focus();
    this.elements.bookmarkNameInput.select();
  }

  closeModals() {
    if (this.elements.modalBlocker) this.elements.modalBlocker.hidden = true;
    if (this.elements.jumpModal) this.elements.jumpModal.hidden = true;
    if (this.elements.bookmarkAddModal) this.elements.bookmarkAddModal.hidden = true;
    if (this.elements.searchModal) this.elements.searchModal.hidden = true;
    if (this.elements.worldsModal) this.elements.worldsModal.hidden = true;
    if (this.elements.accountModal) this.elements.accountModal.hidden = true;
    if (this.elements.exportModal) this.elements.exportModal.hidden = true;
    const battlelogsModal = document.getElementById("battlelogs-modal");
    if (battlelogsModal) battlelogsModal.hidden = true;
    this.pendingBookmarkTarget = null;
  }

  // The yard planner's zoom slider (BasePlannerPopup_ZoomLayout): + and -
  // step the zoom exactly like the retired corner buttons, and the stone
  // thumb drags along the stick - top of the track = fully zoomed IN.
  // Zoom maps to track position logarithmically, matching the renderer's
  // geometric step ladder.
  setupZoomSlider() {
    const { zoomSliderIn, zoomSliderOut, zoomSliderTrack, zoomSliderThumb } =
      this.elements;
    if (!zoomSliderIn || !zoomSliderTrack || !zoomSliderThumb) return;
    zoomSliderIn.addEventListener("click", () => {
      this.renderer?.zoomBy(1.18, true);
    });
    zoomSliderOut?.addEventListener("click", () => {
      this.renderer?.zoomBy(1 / 1.18, true);
    });
    const zoomFromPointer = (event) => {
      if (!this.renderer?.getZoomRange) return;
      const { min, max } = this.renderer.getZoomRange();
      const rect = zoomSliderTrack.getBoundingClientRect();
      const thumbH = zoomSliderThumb.offsetHeight || 8;
      const travel = Math.max(1, rect.height - thumbH);
      const y = Math.min(travel, Math.max(0,
        event.clientY - rect.top - thumbH / 2));
      const t = 1 - y / travel;   // 1 at the top = fully zoomed in
      const zoom = min * ((max / min) ** t);
      this.renderer.cancelAnimations?.();
      this.renderer.setZoom(zoom);
      this.updateZoomThumb();
    };
    zoomSliderTrack.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      zoomSliderTrack.setPointerCapture(event.pointerId);
      this.zoomSliderDragging = true;
      zoomFromPointer(event);
    });
    zoomSliderTrack.addEventListener("pointermove", (event) => {
      if (this.zoomSliderDragging) zoomFromPointer(event);
    });
    const endDrag = () => { this.zoomSliderDragging = false; };
    zoomSliderTrack.addEventListener("pointerup", endDrag);
    zoomSliderTrack.addEventListener("pointercancel", endDrag);
    // Wheel, pinch, double-click and animated zooms all move the camera
    // outside the slider, so the thumb follows on a light poll.
    window.setInterval(() => this.updateZoomThumb(), 120);
    this.updateZoomThumb();
  }

  updateZoomThumb() {
    const track = this.elements.zoomSliderTrack;
    const thumb = this.elements.zoomSliderThumb;
    if (!track || !thumb || !this.renderer?.getZoomRange) return;
    const zoom = Number(this.renderer.zoom);
    if (!Number.isFinite(zoom) || zoom === this.lastZoomThumbValue) return;
    this.lastZoomThumbValue = zoom;
    const { min, max } = this.renderer.getZoomRange();
    const t = Math.min(1, Math.max(0,
      Math.log(zoom / min) / Math.log(max / min)));
    const travel = Math.max(1,
      track.clientHeight - (thumb.offsetHeight || 8));
    thumb.style.top = `${Math.round((1 - t) * travel)}px`;
  }

  // The four relocated widgets behave exactly like the MAP TOOLS box:
  // a wooden bar when closed (the default on every load), the framed
  // panel when open, minimized by the corner "-". Opening keeps the old
  // menu side effects alive: the leaderboard loads on open, and the
  // alliance chat clears its unread count while its panel counts as
  // "in view" via openMenuId.
  // Any <img> that errors retries 5s later with a cache-busting query,
  // up to 4 attempts. Captured at the window so it covers images created
  // anywhere in the app.
  setupAssetRetry() {
    window.addEventListener("error", (event) => {
      const img = event.target;
      if (!(img instanceof HTMLImageElement)) return;
      const tries = Number(img.dataset.retryCount || 0);
      if (tries >= 4) return;
      img.dataset.retryCount = String(tries + 1);
      const src = img.src;
      window.setTimeout(() => {
        if (!img.isConnected) return;
        const base = src.split(/[?&]retry=/)[0];
        const sep = base.includes("?") ? "&" : "?";
        img.src = `${base}${sep}retry=${tries + 1}`;
      }, 5000);
    }, true);
  }

  // CSS background art can't signal errors, so every UI asset is also
  // preloaded with the same 4x5s retry; when an attempt AFTER a failure
  // succeeds, the styles that use it are repainted with the busted URL.
  setupCssAssetRetry() {
    const manifest = [
      ["/assets/ui/tools_bar.png", ".tools-restore,.dock-bar"],
      ["/assets/ui/controls/button_zoom_in.png", ".tools-restore-plus,#zoom-in-button"],
      ["/assets/ui/controls/button_zoom_out.png", "#tools-minimize,.dock-minimize,#zoom-out-button"],
      ["/assets/ui/zoom_plus.png", ".zoom-slider-plus"],
      ["/assets/ui/zoom_minus.png", ".zoom-slider-minus"],
      ["/assets/ui/zoom_track.png", ".zoom-slider-track"],
      ["/assets/ui/zoom_thumb.png", ".zoom-slider-thumb"],
      ["/assets/ui/bookmark_row.png", ".bookmark-row-plate"],
      ["/assets/ui/bookmark_delete.png", ".bookmark-row-delete"],
      ["/assets/ui/button_close.png", ".frame-button-close"],
      ["/assets/gameui/attack/btn_up.png", ".game-button"],
    ];
    for (const [url, selector] of manifest) {
      const attempt = (n) => {
        const img = new Image();
        img.onload = () => {
          if (n > 0 && selector) {
            for (const el of document.querySelectorAll(selector)) {
              el.style.backgroundImage = `url("${url}?retry=${n}")`;
            }
          }
        };
        img.onerror = () => {
          if (n >= 4) return;
          window.setTimeout(() => attempt(n + 1), 5000);
        };
        img.src = n === 0 ? url : `${url}?retry=${n}`;
      };
      attempt(0);
    }
  }

  setupDock() {
    this.dockKeys = ["alliance", "activity", "filters", "leaderboard", "settings"];
    for (const key of this.dockKeys) {
      const bar = document.getElementById(`dock-${key}-bar`);
      const panel = document.getElementById(`dock-${key}-panel`);
      const min = document.getElementById(`dock-${key}-min`);
      if (!bar || !panel) continue;
      bar.addEventListener("click", () => {
        if (!panel.hidden) { this.closeDockPanel(key); return; }
        this.openDockPanel(key);
      });
      min?.addEventListener("click", () => this.closeDockPanel(key));
    }
  }

  updateTopStripVisibility() {
    const strip = document.getElementById("top-strip");
    if (!strip) return;
    if (!this.mapLoaded) { strip.hidden = true; return; }
    const anyDock = (this.dockKeys || []).some((key) => {
      const panel = document.getElementById(`dock-${key}-panel`);
      return panel && !panel.hidden;
    });
    const toolsOpen = this.elements.toolsPanel && !this.elements.toolsPanel.hidden;
    strip.hidden = anyDock || Boolean(toolsOpen);
  }

  openDockPanel(key) {
    if (key === "alliance" && !this.session) {
      // Guests get the sign-in prompt instead of the alliance panel.
      this.openAccountModal();
      return;
    }
    // One box at a time - MAP TOOLS included.
    this.closeAllDockPanels();
    this.setToolsMinimized?.(true);
    const bar = document.getElementById(`dock-${key}-bar`);
    const panel = document.getElementById(`dock-${key}-panel`);
    if (!panel) return;
    panel.hidden = false;
    bar?.classList.add("active");
    if (key === "filters" && this.elements.filterMenu) {
      this.elements.filterMenu.hidden = false;
    }
    this.updateTopStripVisibility();
    if (key === "alliance") {
      this.openMenuId = "menu-alliance";
      if (this.allianceActiveTab === "chat") this.clearAllianceUnread?.();
      // Land at the newest chat and paint names in map colours.
      window.setTimeout(() => {
        const log = document.getElementById("alliance-chat-log");
        if (log) log.scrollTop = log.scrollHeight;
        this.paintAllianceNames();
      }, 30);
    }
    if (key === "leaderboard") {
      const worldId = String(this.viewedWorldId
        || this.session?.map?.worldid || "").trim();
      if (worldId) this.loadLeaderboard(worldId).catch(() => {});
      else {
        this.elements.leaderboardTitle.textContent = "No world selected";
        this.elements.leaderboardList.textContent =
          "View a world to see its leaderboard.";
      }
    }
  }

  closeDockPanel(key) {
    const bar = document.getElementById(`dock-${key}-bar`);
    const panel = document.getElementById(`dock-${key}-panel`);
    if (panel) panel.hidden = true;
    bar?.classList.remove("active");
    if (key === "alliance" && this.openMenuId === "menu-alliance") {
      this.openMenuId = null;
    }
    this.updateTopStripVisibility();
  }

  closeAllDockPanels() {
    for (const key of this.dockKeys || []) this.closeDockPanel(key);
  }

  openAccountModal() {
    this.closeToolbarMenus?.();
    this.hideBookmarkFlyout();
    if (this.elements.modalBlocker) this.elements.modalBlocker.hidden = false;
    if (this.elements.accountModal) this.elements.accountModal.hidden = false;
    // No escape hatch before a map exists: the x only shows once a
    // (guest) map is already loaded behind the modal.
    if (this.elements.accountModalClose) {
      this.elements.accountModalClose.hidden = !this.viewedWorldId;
    }
    const tokenInput = document.getElementById("attach-token-input");
    if (tokenInput) tokenInput.value = "";
    window.setTimeout(() => this.elements.emailInput?.focus?.(), 30);
  }

  // ==================== Export ====================
  openExportModal() {
    this.closeToolbarMenus?.();
    this.hideBookmarkFlyout();
    if (this.elements.modalBlocker) this.elements.modalBlocker.hidden = false;
    if (this.elements.exportModal) this.elements.exportModal.hidden = false;
    this.syncExportModal();
  }

  exportType() {
    return document.querySelector("input[name='export-type']:checked")?.value || "csv";
  }

  syncExportModal() {
    const isCsv = this.exportType() === "csv";
    const csvOpts = document.getElementById("export-csv-options");
    const pngOpts = document.getElementById("export-png-options");
    if (csvOpts) csvOpts.hidden = !isCsv;
    if (pngOpts) pngOpts.hidden = isCsv;
    if (isCsv) this.updateExportCount();
  }

  exportScope() {
    return document.querySelector("input[name='export-scope']:checked")?.value || "filtered";
  }

  exportCols() {
    const cols = new Set();
    for (const box of document.querySelectorAll("[data-export-col]")) {
      if (box.checked) cols.add(box.dataset.exportCol);
    }
    return cols;
  }

  // Main-yard entries for the chosen scope, hidden players excluded.
  async collectExportEntries(scope) {
    const all = (this.searchEntries || []).filter((entry) => {
      if (this.isPlayerHidden(entry.username)) return false;
      return Number(entry.cell?.b) === MR2.yardTypes.main;
    });
    if (scope === "all") return all;
    if (scope === "filtered") {
      return all.filter((entry) => this.renderer?.shouldDisplayBaseCell?.(entry.cell) !== false);
    }
    // top100: the served leaderboard order, joined back to cached mains.
    const worldId = String(this.viewedWorldId || this.session?.map?.worldid || "").trim();
    let rows = [];
    try {
      rows = worldId ? await this.getLeaderboardRows(worldId) : [];
    } catch { rows = []; }
    const byName = new Map(all.map((e) => [e.normalizedUsername, e]));
    const picked = [];
    for (const row of rows.slice(0, 100)) {
      const low = String(row.username || "").trim().toLocaleLowerCase();
      if (this.isPlayerHidden(low)) continue;
      const entry = byName.get(low);
      picked.push(entry || {
        username: String(row.username || ""),
        normalizedUsername: low,
        cell: null,
        servedOutposts: Number(row.outpost_count || 0),
      });
    }
    return picked;
  }

  async updateExportCount() {
    const note = document.getElementById("export-count-note");
    if (!note) return;
    const scope = this.exportScope();
    const requestId = (this.exportCountRequest = (this.exportCountRequest || 0) + 1);
    const entries = await this.collectExportEntries(scope);
    if (requestId !== this.exportCountRequest) return;
    const worldName = (this.elements.worldName?.textContent || "map").trim();
    note.textContent = `${formatNumber(entries.length)} player${entries.length === 1 ? "" : "s"} will be exported from ${worldName}.`;
  }

  csvEscape(value) {
    const text = String(value ?? "");
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }

  downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  exportFileStem() {
    const worldRaw = (this.elements.worldName?.textContent || "map")
      .replace(/\s*server$/i, "").trim().toLocaleLowerCase()
      .replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "map";
    const day = new Date().toISOString().slice(0, 10);
    return `bym_${worldRaw}_${day}`;
  }

  async runExport() {
    if (this.exportType() === "png") {
      this.closeModals();
      this.startRegionSelect();
      return;
    }
    const scope = this.exportScope();
    const cols = this.exportCols();
    const entries = await this.collectExportEntries(scope);
    const worldId = String(this.viewedWorldId || this.session?.map?.worldid || "").trim();
    let history = null;
    if ((cols.has("deltas") || cols.has("history30")) && worldId) {
      try { history = await fetchLeaderboardHistory(worldId); } catch { history = null; }
    }
    const seriesDays = cols.has("history30") ? (history?.series?.days || []) : [];
    const seriesCounts = history?.series?.counts || {};
    const kitCounts = this.renderer?.getOwnerKitCounts?.() || new Map();
    const withOutposts = cols.has("outpost-rows");
    // Every outpost cell by owner uid, highest empire value (v) first.
    let outpostsByUid = null;
    if (withOutposts) {
      outpostsByUid = new Map();
      for (const cell of this.renderer?.cellCache?.values?.() || []) {
        if (Number(cell.b) !== MR2.yardTypes.outpost) continue;
        const ownerId = Number(cell.uid || 0);
        if (ownerId <= 0) continue;
        if (!outpostsByUid.has(ownerId)) outpostsByUid.set(ownerId, []);
        outpostsByUid.get(ownerId).push(cell);
      }
      for (const list of outpostsByUid.values()) {
        list.sort((a, b) => Number(b.v || 0) - Number(a.v || 0));
      }
    }
    const header = [];
    if (withOutposts) header.push("type");
    if (cols.has("identity")) header.push("username", "uid", "level");
    // uid is the rename-proof join key - always present.
    else header.push("username", "uid");
    if (cols.has("position")) header.push("x", "y");
    if (withOutposts) header.push("kit", "empire_value");
    if (cols.has("outposts")) header.push("outposts", "kit_none", "kit_regular", "kit_mega", "kit_ultra");
    if (cols.has("alliance")) header.push("alliance");
    if (cols.has("deltas")) header.push("d1", "d7", "d30");
    if (cols.has("status")) header.push("damage_pct", "last_updated");
    if (cols.has("loot")) header.push("loot_total", "twigs", "pebbles", "putty", "goo");
    // One column per stored day, oldest first: op_2026-07-12, ...
    for (const day of seriesDays) header.push(`op_${day}`);
    const lines = [header.join(",")];
    const pushRow = (kind, entry, cell, uid) => {
      const low = entry.normalizedUsername;
      const kits = kind === "main" ? (kitCounts.get(low) || null) : null;
      const row = [];
      if (withOutposts) row.push(kind);
      if (cols.has("identity")) row.push(entry.username, uid || "", Number(cell?.l || 0) || "");
      else row.push(entry.username, uid || "");
      if (cols.has("position")) row.push(cell ? cell.x : "", cell ? cell.y : "");
      if (withOutposts) {
        row.push(kind === "outpost" ? this.describeOutpostKit(Number(cell?.v || 0)) : "",
          kind === "outpost" ? Number(cell?.v || 0) : "");
      }
      if (cols.has("outposts")) {
        if (kind === "main") {
          const op = uid > 0
            ? Number(this.renderer?.getOwnedBaseCounts?.(uid)?.outpost || 0)
            : Number(entry.servedOutposts || 0);
          row.push(op, kits?.none ?? "", kits?.regular ?? "", kits?.mega ?? "", kits?.ultra ?? "");
        } else {
          row.push("", "", "", "", "");
        }
      }
      if (cols.has("alliance")) row.push(this.getPlayerAllianceName(entry.username) || "");
      if (cols.has("deltas")) {
        for (const w of ["1", "7", "30"]) {
          const win = history?.windows?.[w];
          row.push(kind === "main" && win && uid
            ? Number(win.deltas?.[String(uid)] ?? 0) : "");
        }
      }
      if (cols.has("status")) {
        row.push(Number(cell?.dm || 0) || 0,
          cell ? new Date((this.getCellObservedAt(cell) || 0)).toISOString() : "");
      }
      if (cols.has("loot")) {
        if (kind === "main" && cell) {
          row.push(getCellLootTotal(cell),
            Number(cell?.r?.r1 || 0), Number(cell?.r?.r2 || 0),
            Number(cell?.r?.r3 || 0), Number(cell?.r?.r4 || 0));
        } else {
          row.push("", "", "", "", "");
        }
      }
      if (seriesDays.length) {
        const perDay = (kind === "main" && uid) ? (seriesCounts[String(uid)] || null) : null;
        for (const day of seriesDays) {
          row.push(perDay && day in perDay ? perDay[day] : "");
        }
      }
      lines.push(row.map((v) => this.csvEscape(v)).join(","));
    };
    for (const entry of entries) {
      const cell = entry.cell;
      const uid = Number(cell?.uid || 0);
      pushRow("main", entry, cell, uid);
      if (withOutposts && uid > 0) {
        for (const outpost of outpostsByUid.get(uid) || []) {
          pushRow("outpost", entry, outpost, uid);
        }
      }
    }
    this.downloadBlob(new Blob([lines.join("\r\n")], { type: "text/csv" }),
      `${this.exportFileStem()}_players.csv`);
    this.closeModals();
    this.showGameToast(`Exported ${formatNumber(entries.length)} players.`);
  }

  // -------- Map snapshot: drag a region, adjustable corners --------
  startRegionSelect() {
    const layer = document.getElementById("export-select-layer");
    if (!layer || !this.renderer) return;
    this.exportAnno = {};
    for (const box of document.querySelectorAll("[data-export-anno]")) {
      this.exportAnno[box.dataset.exportAnno] = box.checked;
    }
    this.exportLod = document.querySelector("input[name='export-lod']:checked")?.value || "high";
    this.exportRes = document.querySelector("input[name='export-res']:checked")?.value || "high";
    this.exportSel = null;             // {x0,y0,x1,y1} cell coords
    this.exportDrag = null;
    layer.hidden = false;
    if (!layer.dataset.wired) {
      layer.dataset.wired = "1";
      const toCell = (event) => {
        const rect = this.renderer.canvas.getBoundingClientRect();
        const worldX = this.renderer.offsetX + (event.clientX - rect.left) / this.renderer.zoom;
        const worldY = this.renderer.offsetY + (event.clientY - rect.top) / this.renderer.zoom;
        const cx = Math.round(worldX / MR2.columnStep);
        const cy = Math.round((worldY - (cx % 2 ? MR2.oddColumnOffset : 0)) / MR2.cellHeight);
        return { x: cx, y: cy };
      };
      layer.addEventListener("pointerdown", (event) => {
        if (event.target.closest(".export-select-toolbar")) return;
        const handle = event.target.closest(".export-corner");
        layer.setPointerCapture(event.pointerId);
        if (handle && this.exportSel) {
          this.exportDrag = { corner: handle.dataset.corner };
        } else {
          const cell = toCell(event);
          this.exportSel = { x0: cell.x, y0: cell.y, x1: cell.x, y1: cell.y };
          this.exportDrag = { corner: "se" };
        }
        event.preventDefault();
      });
      layer.addEventListener("pointermove", (event) => {
        if (!this.exportDrag || !this.exportSel) return;
        const cell = toCell(event);
        const sel = this.exportSel;
        const corner = this.exportDrag.corner;
        if (corner.includes("w")) sel.x0 = cell.x; else sel.x1 = cell.x;
        if (corner.includes("n")) sel.y0 = cell.y; else sel.y1 = cell.y;
        this.paintRegionSelect();
      });
      layer.addEventListener("pointerup", () => { this.exportDrag = null; });
      window.addEventListener("keydown", (event) => {
        if (event.key === "Escape" && !layer.hidden) this.endRegionSelect();
      });
    }
    this.paintRegionSelect();
    this.showGameToast("Drag a box on the map. Drag any corner to adjust.");
  }

  regionBounds() {
    const sel = this.exportSel;
    if (!sel) return null;
    return {
      x0: Math.min(sel.x0, sel.x1), x1: Math.max(sel.x0, sel.x1),
      y0: Math.min(sel.y0, sel.y1), y1: Math.max(sel.y0, sel.y1),
    };
  }

  paintRegionSelect() {
    const box = document.getElementById("export-select-box");
    const dims = document.getElementById("export-select-dims");
    const bounds = this.regionBounds();
    if (!box) return;
    if (!bounds) { box.hidden = true; if (dims) dims.textContent = "Drag to select"; return; }
    const r = this.renderer;
    const left = (bounds.x0 * MR2.columnStep - r.offsetX) * r.zoom;
    const top = (bounds.y0 * MR2.cellHeight - r.offsetY) * r.zoom;
    const width = ((bounds.x1 - bounds.x0 + 1) * MR2.columnStep) * r.zoom;
    const height = ((bounds.y1 - bounds.y0 + 1) * MR2.cellHeight) * r.zoom;
    box.hidden = false;
    box.style.left = `${left}px`;
    box.style.top = `${top}px`;
    box.style.width = `${width}px`;
    box.style.height = `${height}px`;
    if (!box.dataset.handles) {
      box.dataset.handles = "1";
      for (const corner of ["nw", "ne", "sw", "se"]) {
        const h = document.createElement("div");
        h.className = `export-corner export-corner-${corner}`;
        h.dataset.corner = corner;
        box.appendChild(h);
      }
    }
    if (dims) {
      const w = bounds.x1 - bounds.x0 + 1;
      const hgt = bounds.y1 - bounds.y0 + 1;
      dims.textContent = `${w} x ${hgt} cells`;
    }
  }

  endRegionSelect() {
    const layer = document.getElementById("export-select-layer");
    if (layer) layer.hidden = true;
    this.exportSel = null;
    this.exportDrag = null;
  }

  finishRegionExport() {
    const bounds = this.regionBounds();
    if (!bounds) { this.showGameToast("Drag a box on the map first."); return; }
    if (typeof this.renderer?.renderToCanvas !== "function") {
      // Mixed script versions after a deploy: the entry module updated
      // but the renderer module came from the browser cache.
      this.showGameToast("Export needs a refresh - press Ctrl+F5 and try again.");
      console.warn("[BYM-MR2] renderToCanvas missing - stale cached map-renderer.js");
      this.endRegionSelect();
      return;
    }
    this.endRegionSelect();
    (async () => {
      try {
        console.info("[BYM-MR2] Region export:", JSON.stringify(bounds));
        await this.renderRegionExport(bounds, this.exportAnno || {});
        console.info("[BYM-MR2] Region export rendered.");
      } catch (error) {
        console.error("[BYM-MR2] Region export failed:", error);
        this.setExportProgress(null);
        const reason = sanitizeErrorMessage(error?.message || "unknown error");
        this.showGameToast(`Export failed: ${reason}`);
      }
    })();
  }

  setExportProgress(text) {
    let el = document.getElementById("export-progress");
    if (!text) { if (el) el.remove(); return; }
    if (!el) {
      el = document.createElement("div");
      el.id = "export-progress";
      document.body.appendChild(el);
    }
    el.textContent = text;
  }

  async renderRegionExport(bounds, anno) {
    const r = this.renderer;
    const mapW = r.getMapWidth();
    const mapH = r.getMapHeight();
    const wCells = Math.min(bounds.x1 - bounds.x0 + 1, mapW);
    const hCells = Math.min(bounds.y1 - bounds.y0 + 1, mapH);
    // Region size in world units (odd columns hang half a cell lower, so
    // pad half a cell of height; a full cell of width for the last tile).
    const worldW = wCells * MR2.columnStep + (MR2.cellWidth - MR2.columnStep);
    const worldH = (hCells + 0.5) * MR2.cellHeight;
    // The chosen LOD sets the zoom the pipeline renders at: high sits
    // just above the detail threshold (or the current zoom if higher),
    // low just below it. Size caps still apply; if a huge region forces
    // high detail under the threshold, the render degrades to the map
    // view and says so.
    const detailMin = r.detailedMinZoom?.() || r.zoom;
    // Resolution picker scales every budget: Standard for quick shares,
    // Maximum pushes toward browser canvas limits.
    const resMult = { std: 0.6, high: 1, max: 1.4 }[this.exportRes || "high"] || 1;
    let zoom;
    let forceDetailed = false;
    if (this.exportLod === "low") {
      const lowCap = Math.min(8192 * resMult, 12000);
      zoom = Math.min(Math.min(r.zoom, detailMin * 0.9), lowCap / worldW, lowCap / worldH);
    } else {
      // High detail works at ANY region size: the render is forced down
      // the detailed-tile branch even when the size caps push the zoom
      // below the normal LOD threshold - huge regions just get smaller
      // tiles rather than falling back to the map view.
      forceDetailed = true;
      const dimCap = Math.min(14000 * resMult, 16000);
      const areaCap = Math.min(110e6 * resMult * resMult, 160e6);
      const capDim = Math.min(dimCap / worldW, dimCap / worldH);
      const capArea = Math.sqrt(areaCap / (worldW * worldH));
      zoom = Math.min(Math.max(r.zoom, detailMin * 1.02), capDim, capArea);
      if (zoom < detailMin) {
        this.showGameToast("Very large region - detail scaled to the browser's canvas limits.");
      }
    }
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(8, Math.round(worldW * zoom));
    canvas.height = Math.max(8, Math.round(worldH * zoom));
    const origin = r.cellToWorld(bounds.x0, bounds.y0);
    // Chunked rendering: vertical bands of at most ~12MP each, yielding a
    // frame between bands so the tab stays responsive and the progress
    // bar can paint. Small exports are a single band (no overhead).
    const bandCount = Math.max(1, Math.ceil((canvas.width * canvas.height) / 12e6));
    const bandPxW = Math.ceil(canvas.width / bandCount);
    const targetCtx = canvas.getContext("2d", { alpha: false });
    for (let band = 0; band < bandCount; band += 1) {
      const x0px = band * bandPxW;
      const wPx = Math.min(bandPxW, canvas.width - x0px);
      if (wPx <= 0) break;
      if (bandCount > 1) {
        this.setExportProgress(`Rendering export... ${Math.round((band / bandCount) * 100)}%`);
        await new Promise((resolve) => window.requestAnimationFrame(resolve));
      }
      const strip = document.createElement("canvas");
      strip.width = wPx;
      strip.height = canvas.height;
      r.renderToCanvas(strip, {
        offsetX: origin.x + x0px / zoom,
        offsetY: origin.y,
        zoom,
        forceDetailed,
      });
      targetCtx.drawImage(strip, x0px, 0);
    }
    this.setExportProgress(null);

    const ctx = canvas.getContext("2d");
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (anno.legend && canvas.width >= 140 && canvas.height >= 100) {
      const rows = [["#5aa9ff", "You"], ["#34d6ec", "Allies"], ["#ff5c4a", "Enemies"]];
      const lh = 16; const pad = 8;
      const boxH = rows.length * lh + pad * 2;
      ctx.fillStyle = "rgba(0,0,0,0.82)";
      ctx.fillRect(6, canvas.height - boxH - 6, 104, boxH);
      ctx.font = "700 11px Verdana, sans-serif";
      ctx.textAlign = "left";
      rows.forEach(([color, label], i) => {
        const yy = canvas.height - boxH - 6 + pad + i * lh;
        ctx.fillStyle = color;
        ctx.fillRect(12, yy + 2, 10, 10);
        ctx.fillStyle = "#fff";
        ctx.fillText(label, 28, yy + 11);
      });
    }
    if (anno.stamp) {
      const worldName = (this.elements.worldName?.textContent || "").trim() || "MR2";
      let text = `${worldName} - ${new Date().toISOString().slice(0, 10)} - maproom2.com`;
      let fontPx = 11;
      ctx.font = `700 ${fontPx}px Verdana, sans-serif`;
      if (ctx.measureText(text).width + 20 > canvas.width) {
        text = `${worldName} - ${new Date().toISOString().slice(0, 10)}`;
        fontPx = 9;
        ctx.font = `700 ${fontPx}px Verdana, sans-serif`;
      }
      const width = ctx.measureText(text).width + 14;
      if (width + 6 <= canvas.width) {
        ctx.fillStyle = "rgba(0,0,0,0.82)";
        ctx.fillRect(canvas.width - width - 6, canvas.height - 24, width, 18);
        ctx.fillStyle = "#f2c76b";
        ctx.textAlign = "left";
        ctx.fillText(text, canvas.width - width, canvas.height - 11);
      }
    }
    try {
      canvas.toBlob((blob) => {
        if (blob) this.downloadBlob(blob, `${this.exportFileStem()}_map.png`);
      }, "image/png");
    } catch (error) {
      // Detailed tiles come from the game CDN without CORS approval, so a
      // high-LOD render taints the canvas and cannot be saved. Fall back
      // to the clean compositor (terrain bitmap + vector markers), which
      // is always exportable.
      console.warn("[BYM-MR2] Detailed export blocked (canvas tainted); using map-view fallback.", error);
      this.renderRegionExportFallback(bounds, anno);
      this.showGameToast("Detailed art can't be saved (CDN restriction) - exported the map view instead.");
    }
  }

  // Taint-proof fallback: world terrain bitmap (putImageData, never
  // tainted) stretched to true cell proportions, with vector markers,
  // labels, legend and stamp. Wrap-aware like the live map.
  renderRegionExportFallback(bounds, anno) {
    const r = this.renderer;
    const bitmap = r.worldBitmapFor();
    const mapW = bitmap.width;
    const mapH2 = bitmap.height;
    const mapH = Math.floor(mapH2 / 2);
    const mod = (v, m) => ((v % m) + m) % m;
    const wCells = Math.min(bounds.x1 - bounds.x0 + 1, mapW);
    const hCells = Math.min(bounds.y1 - bounds.y0 + 1, mapH);
    const srcW = wCells;
    const srcH = Math.min(hCells * 2 + 1, mapH2);
    const src = document.createElement("canvas");
    src.width = srcW;
    src.height = srcH;
    const sctx = src.getContext("2d");
    const sx0 = mod(bounds.x0, mapW);
    const sy0 = mod(bounds.y0 * 2, mapH2);
    for (let ox = 0; ox < srcW;) {
      const colStart = mod(sx0 + ox, mapW);
      const cw = Math.min(mapW - colStart, srcW - ox);
      for (let oy = 0; oy < srcH;) {
        const rowStart = mod(sy0 + oy, mapH2);
        const ch = Math.min(mapH2 - rowStart, srcH - oy);
        sctx.drawImage(bitmap, colStart, rowStart, cw, ch, ox, oy, cw, ch);
        oy += ch;
      }
      ox += cw;
    }
    // True proportions: a cell is columnStep wide per cellHeight tall
    // (1.5:1); the bitmap stores it 1 wide x 2 tall.
    const ratio = MR2.columnStep / MR2.cellHeight;   // 1.5
    const fbCap = Math.min(8192 * ({ std: 0.6, high: 1, max: 1.4 }[this.exportRes || "high"] || 1), 12000);
    const pxY = Math.max(4, Math.min(48, Math.floor(Math.min(
      fbCap / (wCells * ratio), fbCap / (hCells + 0.5)))));
    const pxX = pxY * ratio;
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(wCells * pxX);
    canvas.height = Math.round((hCells + 0.5) * pxY);
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(src, 0, 0, srcW, srcH, 0, 0,
      canvas.width, Math.round(srcH * (pxY / 2)));

    const labels = [];
    for (const cell of r.cellCache.values()) {
      const dx = mod(Number(cell.x) - bounds.x0, mapW);
      const dy = mod(Number(cell.y) - bounds.y0, mapH);
      if (dx >= wCells || dy >= hCells) continue;
      const baseType = Number(cell.b);
      if (baseType !== MR2.yardTypes.main && baseType !== MR2.yardTypes.outpost) continue;
      if (r.isCellHidden?.(cell)) continue;
      if (r.shouldDisplayBaseCell?.(cell) === false) continue;
      const odd = Number(cell.x) % 2 ? 0.5 : 0;
      const px = (dx + 0.5) * pxX;
      const py = (dy + odd + 0.5) * pxY;
      let color = "#d9d9cf";
      if (Number(cell.mine || 0) === 1) color = "#5aa9ff";
      else {
        const role = r.getPlayerHighlightColor?.(cell);
        if (role === "ally") color = "#34d6ec";
        else if (role === "enemy") color = "#ff5c4a";
      }
      const size = Math.max(3, Math.round(pxY * (baseType === MR2.yardTypes.main ? 0.75 : 0.5)));
      ctx.fillStyle = color;
      ctx.strokeStyle = "rgba(0,0,0,0.8)";
      ctx.fillRect(px - size / 2, py - size / 2, size, size);
      ctx.strokeRect(px - size / 2, py - size / 2, size, size);
      if (baseType === MR2.yardTypes.main && String(cell.n || "").trim()) {
        labels.push({ px, py: py - size, name: String(cell.n).trim(), color });
      }
    }
    const fontPx = Math.max(10, Math.min(15, Math.round(pxY * 0.9)));
    ctx.font = `700 ${fontPx}px Verdana, sans-serif`;
    ctx.textAlign = "center";
    ctx.lineWidth = 3;
    for (const label of labels) {
      ctx.strokeStyle = "rgba(0,0,0,0.9)";
      ctx.strokeText(label.name, label.px, label.py - 2);
      ctx.fillStyle = label.color;
      ctx.fillText(label.name, label.px, label.py - 2);
    }
    if (anno.legend && canvas.width >= 140 && canvas.height >= 100) {
      const rows = [["#5aa9ff", "You"], ["#34d6ec", "Allies"], ["#ff5c4a", "Enemies"]];
      const lh = 16; const pad = 8;
      const boxH = rows.length * lh + pad * 2;
      ctx.fillStyle = "rgba(0,0,0,0.82)";
      ctx.fillRect(6, canvas.height - boxH - 6, 104, boxH);
      ctx.font = "700 11px Verdana, sans-serif";
      ctx.textAlign = "left";
      rows.forEach(([color, label], i) => {
        const yy = canvas.height - boxH - 6 + pad + i * lh;
        ctx.fillStyle = color;
        ctx.fillRect(12, yy + 2, 10, 10);
        ctx.fillStyle = "#fff";
        ctx.fillText(label, 28, yy + 11);
      });
    }
    if (anno.stamp) {
      const worldName = (this.elements.worldName?.textContent || "").trim() || "MR2";
      let text = `${worldName} - ${new Date().toISOString().slice(0, 10)} - maproom2.com`;
      ctx.font = "700 11px Verdana, sans-serif";
      if (ctx.measureText(text).width + 20 > canvas.width) {
        text = `${worldName} - ${new Date().toISOString().slice(0, 10)}`;
        ctx.font = "700 9px Verdana, sans-serif";
      }
      const width = ctx.measureText(text).width + 14;
      if (width + 6 <= canvas.width) {
        ctx.fillStyle = "rgba(0,0,0,0.82)";
        ctx.fillRect(canvas.width - width - 6, canvas.height - 24, width, 18);
        ctx.fillStyle = "#f2c76b";
        ctx.textAlign = "left";
        ctx.fillText(text, canvas.width - width, canvas.height - 11);
      }
    }
    canvas.toBlob((blob) => {
      if (blob) this.downloadBlob(blob, `${this.exportFileStem()}_map.png`);
    }, "image/png");
  }

  openWorldsModal() {
    this.closeToolbarMenus?.();
    this.hideBookmarkFlyout();
    this.renderWorldList();
    if (this.elements.modalBlocker) this.elements.modalBlocker.hidden = false;
    if (this.elements.worldsModal) this.elements.worldsModal.hidden = false;
  }

  showGameToast(message) {
    const host = document.getElementById("map-panel") || document.body;
    const toast = document.createElement("div");
    toast.className = "mr2-toast";
    toast.textContent = message;
    host.appendChild(toast);
    window.setTimeout(() => { toast.style.opacity = "0"; }, 2000);
    window.setTimeout(() => { toast.remove(); }, 2400);
  }

  toggleBookmarkFlyout() {
    if (!this.session) {
      this.openAccountModal();
      return;
    }
    const fly = this.elements.bookmarkFlyout;
    if (!fly) return;
    // ShowBookmarkMenu: with bookmarks it toggles the row stack; with
    // none it does nothing visible (the game simply has no rows to show).
    if (!fly.hidden) { this.hideBookmarkFlyout(); return; }
    if (!this.bookmarks?.length) return;
    this.renderBookmarks();
    fly.hidden = false;
  }

  hideBookmarkFlyout() {
    if (this.elements.bookmarkFlyout) this.elements.bookmarkFlyout.hidden = true;
  }

  loadBookmarks() {
    this.bookmarks = [];
    const parsed = this.userSettings?.bookmarks?.[this.getWorldSettingsKey()];
    if (Array.isArray(parsed)) {
      this.bookmarks = parsed
        .filter((entry) => entry && Number.isFinite(Number(entry.x)) && Number.isFinite(Number(entry.y)))
        .map((entry) => ({
          name: String(entry.name || `${entry.x}, ${entry.y}`).slice(0, 40),
          x: Number(entry.x),
          y: Number(entry.y),
          createdAt: Number(entry.createdAt || 0),
        }));
    }

    debugLog(`Loaded ${this.bookmarks.length} bookmark(s) for this world.`);
    this.renderBookmarks();
  }

  saveBookmarks() {
    if (!this.session || !this.userSettings) {
      return;
    }

    this.userSettings.bookmarks[this.getWorldSettingsKey()] = this.bookmarks;
    this.scheduleSaveUserSettings();
  }

  // MapRoom.BookmarkAdd shape, minus the game's 8-cap (browser
  // bookmarks are deliberately unlimited): exact-duplicate locations
  // rejected, success closes the modal, and adding only happens from a
  // cell's Bookmark button (the game has no add path on the toolbar).
  handleAddBookmark() {
    const target = this.pendingBookmarkTarget;
    if (!this.session || !target) {
      this.closeModals();
      return;
    }
    if (this.bookmarks.some((b) => b.x === target.x && b.y === target.y)) {
      this.closeModals();
      this.showGameToast("You have already bookmarked this location.");
      return;
    }
    const name = (this.elements.bookmarkNameInput.value.trim()
      || `${target.x}, ${target.y}`).slice(0, 40);
    this.bookmarks.push({ name, x: target.x, y: target.y, createdAt: Date.now() });
    this.closeModals();
    this.saveBookmarks();
    this.renderBookmarks();
    debugLog("Bookmark saved:", name, target);
  }

  removeBookmark(index) {
    const removed = this.bookmarks.splice(index, 1)[0];
    this.saveBookmarks();
    this.renderBookmarks();
    if (!this.bookmarks.length) this.hideBookmarkFlyout();
    if (removed) {
      debugLog("Bookmark removed:", removed.name);
    }
  }

  renderBookmarks() {
    const container = this.elements.bookmarkFlyout;
    if (!container) return;
    container.replaceChildren();
    if (!this.session || !this.bookmarks.length) {
      container.hidden = true;
      return;
    }
    // One MapRoomBookmark plate per bookmark: the row art is the game's
    // symbol 2023 background, the name sits on it (clicks fall through to
    // the plate = select), and the x is buttonClose art (= remove).
    this.bookmarks.forEach((bookmark, index) => {
      const row = document.createElement("div");
      row.style.position = "relative";
      const plate = document.createElement("button");
      plate.type = "button";
      plate.className = "bookmark-row-plate";
      plate.textContent = bookmark.name;
      plate.title = `Jump to ${bookmark.x}, ${bookmark.y}`;
      plate.addEventListener("click", () => {
        this.hideBookmarkFlyout();
        this.renderer?.jumpToCoordinates(bookmark.x, bookmark.y);
      });
      const del = document.createElement("button");
      del.type = "button";
      del.className = "bookmark-row-delete";
      del.title = "Delete bookmark";
      del.textContent = "\u00d7";
      del.addEventListener("click", (event) => {
        event.stopPropagation();
        this.removeBookmark(index);
      });
      row.append(plate, del);
      container.appendChild(row);
    });
  }

  // Ally and enemy groups are controlled entirely by the alliance: members
  // are the allies, and the alliance's shared enemy list is the enemies.
  // (The old per-user Groups tab is gone; the signed-in user is still always
  // treated as an ally of themselves so their zones stay fresh.)
  applyHighlightsToRenderer() {
    if (!this.renderer) {
      return;
    }

    const allies = [];
    const ownName = String(this.session?.user?.username || "").trim();
    if (ownName) {
      allies.push(ownName);
    }
    for (const member of this.allianceMemberNames) {
      if (!allies.some((name) => name.toLocaleLowerCase() === member.toLocaleLowerCase())) {
        allies.push(member);
      }
    }

    this.renderer.setPlayerHighlights({
      allies,
      enemies: [...this.allianceEnemyNames],
    });
  }

  // Fires when the background cache stream finishes: the search index and
  // filter data built right after the instant viewport-only restore only
  // covered a sliver of the explored world.
  handleCacheHydrated() {
    this.revealDocks();
    this.rebuildSearchIndex();
    this.rebuildFilterOptions(true);
    if (this.elements.searchInput && !this.elements.searchInput.disabled) {
      this.setSearchEnabled(
        true,
        this.searchEntries.length
          ? `${formatNumber(this.searchEntries.length)} player bases indexed from ${this.session ? "explored" : "cached"} zones.`
          : "No player bases explored yet. Pan the map to discover bases.",
      );
    }
    // (rebuildFilterOptions re-applies filters itself, re-resolving any
    // active big-fish / inactivity sets against the now-complete data.)
    debugLog("Cache hydration complete; search and filters rebuilt.",
      this.searchEntries.length, "bases indexed.");
  }

  hideDockUi() {
    this.mapLoaded = false;
    for (const id of ["left-dock", "right-dock"]) {
      const dock = document.getElementById(id);
      if (dock) dock.hidden = true;
    }
    const cluster = document.querySelector(".corner-buttons");
    if (cluster) cluster.hidden = true;
    this.updateTopStripVisibility();
  }

  // The tool boxes stay hidden until the map has actually loaded.
  revealDocks() {
    for (const id of ["left-dock", "right-dock"]) {
      const dock = document.getElementById(id);
      if (dock) dock.hidden = false;
    }
    const cluster = document.querySelector(".corner-buttons");
    if (cluster) cluster.hidden = false;
    this.mapLoaded = true;
    this.updateTopStripVisibility();
    // Guests see the Alliance bar too (opening it prompts sign-in), and
    // their Activity feed starts on the Server tab.
    if (!this.session) {
      if (this.elements.allianceItem) this.elements.allianceItem.hidden = false;
      this.setActivityTab?.("server");
    }
  }

  rebuildSearchIndex() {
    this.searchEntries = this.renderer
      ? this.renderer.getSearchablePlayerBases().sort((left, right) => {
        if (left.distance !== right.distance) {
          return Number(left.distance ?? Number.MAX_SAFE_INTEGER) - Number(right.distance ?? Number.MAX_SAFE_INTEGER);
        }

        return left.normalizedUsername.localeCompare(right.normalizedUsername);
      })
      : [];
    this.searchMatches = [];
    this.searchActiveIndex = -1;
    this.elements.searchInput.value = "";
    this.hideSearchResults();
  }

  rebuildFilterOptions(preserveState = false) {
    if (!preserveState) {
      this.filterState = createEmptyBaseFilter();
    }

    this.availableFilterLevels = this.renderer ? this.renderer.getAvailableWildBaseLevels() : [];
    this.ownerOutpostCounts = this.renderer ? this.renderer.getOwnerOutpostCounts() : new Map();
    // Reduce rather than spread: a fully scanned world has thousands of
    // owners, and spreading that many arguments into Math.max can exceed
    // the engine's argument limit and throw.
    let maxOutposts = 0;
    for (const count of this.ownerOutpostCounts.values()) {
      if (count > maxOutposts) {
        maxOutposts = count;
      }
    }
    this.availableOutpostMax = maxOutposts;
    this.playerFilterEntries = this.buildPlayerFilterEntries();
    this.playerFilterMatches = [];
    this.playerFilterActiveIndex = -1;
    if (preserveState) {
      const validOwnerIds = new Set(this.playerFilterEntries.map((entry) => entry.ownerId));
      const availableMinLevel = this.availableFilterLevels[0] ?? null;
      const availableMaxLevel = this.availableFilterLevels[this.availableFilterLevels.length - 1] ?? null;
      let levelMin = Number(this.filterState.levelMin || 0) > 0 ? Number(this.filterState.levelMin) : null;
      let levelMax = Number(this.filterState.levelMax || 0) > 0 ? Number(this.filterState.levelMax) : null;

      if (!this.availableFilterLevels.length) {
        levelMin = null;
        levelMax = null;
      } else {
        if (levelMin !== null) {
          levelMin = this.availableFilterLevels.find((level) => level >= levelMin) ?? availableMaxLevel;
        }

        if (levelMax !== null) {
          levelMax = [...this.availableFilterLevels].reverse().find((level) => level <= levelMax) ?? availableMinLevel;
        }

        if (levelMin !== null && levelMax !== null && levelMin > levelMax) {
          levelMin = levelMax;
        }

        if (levelMin === availableMinLevel) {
          levelMin = null;
        }

        if (levelMax === availableMaxLevel) {
          levelMax = null;
        }
      }

      let outpostMin = Number(this.filterState.outpostMin || 0) > 0
        ? Number(this.filterState.outpostMin)
        : null;
      let outpostMax = (this.filterState.outpostMax ?? null) !== null
        ? Math.max(0, Number(this.filterState.outpostMax))
        : null;
      if (!this.availableOutpostMax) {
        outpostMin = null;
        outpostMax = null;
      } else {
        if (outpostMin !== null) {
          outpostMin = Math.min(outpostMin, this.availableOutpostMax);
        }
        if (outpostMax !== null) {
          outpostMax = Math.min(outpostMax, this.availableOutpostMax);
        }
        if (outpostMin !== null && outpostMax !== null && outpostMin > outpostMax) {
          [outpostMin, outpostMax] = [outpostMax, outpostMin];
          outpostMin = outpostMin > 0 ? outpostMin : null;
        }
      }

      this.filterState = {
        ...this.filterState,
        levelMin,
        levelMax,
        outpostMin,
        outpostMax,
        // Players whose bases are no longer in the explored cache drop off
        // rather than filtering the map to nothing.
        players: this.filterState.players.filter((player) =>
          validOwnerIds.has(Number(player.ownerId || 0))),
        types: this.filterState.types.filter((key) => ALL_TYPE_FILTER_KEYS.includes(key)),
        kits: this.filterState.kits.filter((key) => ALL_KIT_FILTER_KEYS.includes(key)),
      };
    }
    this.renderFilterOptions();
    this.applyFilters();
  }

  buildPlayerFilterEntries() {
    if (!this.renderer) {
      return [];
    }

    const seenOwnerIds = new Set();
    return this.renderer
      .getSearchablePlayerBases()
      .filter((entry) => {
        const ownerId = Number(entry.ownerId || 0);
        if (ownerId <= 0 || seenOwnerIds.has(ownerId)) {
          return false;
        }

        seenOwnerIds.add(ownerId);
        return true;
      })
      .sort((left, right) => {
        if (left.distance !== right.distance) {
          return Number(left.distance ?? Number.MAX_SAFE_INTEGER) - Number(right.distance ?? Number.MAX_SAFE_INTEGER);
        }

        return left.normalizedUsername.localeCompare(right.normalizedUsername);
      });
  }

  setSearchEnabled(enabled, message = "") {
    this.elements.searchInput.disabled = !enabled;
    if (!enabled) {
      this.searchEntries = [];
      this.searchMatches = [];
      this.searchActiveIndex = -1;
      this.elements.searchInput.value = "";
      this.setMobileSearchOpen(false);
      this.hideSearchResults();
    }

    this.syncSearchToggleButtonState();

    if (this.elements.searchStatus) {
      this.elements.searchStatus.hidden = !message;
      this.elements.searchStatus.textContent = message;
    }
  }

  setFilterEnabled(enabled) {
    this.elements.filterToggleButton.disabled = !enabled;

    if (!enabled) {
      this.filterState = createEmptyBaseFilter();
      this.availableFilterLevels = [];
      this.playerFilterEntries = [];
      this.playerFilterMatches = [];
      this.playerFilterActiveIndex = -1;
      this.setFilterMenuOpen(false);
    }

    this.renderFilterOptions();
    this.syncFilterButtonState();
    this.renderer?.setBaseFilter(this.buildRendererFilter());
    this.updateFilterStatus(enabled);
    this.updateFilterMatchCount(enabled);
    if (!enabled) {
      this.hidePlayerFilterResults();
    }
  }

  handleFilterToggle() {
    if (this.elements.filterToggleButton.disabled) {
      return;
    }

    this.setFilterMenuOpen(!this.filterMenuOpen);
  }

  setFilterMenuOpen(isOpen) {
    const nextIsOpen = Boolean(isOpen) && !this.elements.filterToggleButton.disabled;

    if (this.filterMenuCloseTimer) {
      window.clearTimeout(this.filterMenuCloseTimer);
      this.filterMenuCloseTimer = 0;
    }

    if (nextIsOpen && this.isMobileLayout) {
      this.setMobileSearchOpen(false);
    }

    this.filterMenuOpen = nextIsOpen;

    if (this.filterMenuOpen) {
      // Same WebKit fixed-inside-scroller workaround as the toolbar menus:
      // painted from inside .toolbar-scroll, this menu went behind the map
      // canvas on iPhones.
      this.portalFloatingMenu(this.elements.filterMenu);
      this.elements.filterMenu.hidden = false;
      this.positionToolbarDropdown(this.elements.filterMenu, this.elements.filterToggleButton);
      this.elements.filterMenu.classList.remove("closing");
      window.requestAnimationFrame(() => {
        if (!this.filterMenuOpen) {
          return;
        }
        this.elements.filterMenu.classList.add("open");
      });
    } else {
      this.elements.filterMenu.classList.remove("open");
      if (!this.elements.filterMenu.hidden) {
        this.elements.filterMenu.classList.add("closing");
        this.filterMenuCloseTimer = window.setTimeout(() => {
          if (this.filterMenuOpen) {
            return;
          }
          this.elements.filterMenu.hidden = true;
          this.elements.filterMenu.classList.remove("closing");
          // Only after the close animation finished and the menu is hidden:
          // sending it home mid-animation would visibly re-layer it.
          this.restoreFloatingMenu(this.elements.filterMenu);
          this.filterMenuCloseTimer = 0;
        }, FILTER_MENU_TRANSITION_MS);
      } else {
        this.restoreFloatingMenu(this.elements.filterMenu);
      }
    }

    this.elements.appRoot.classList.toggle("mobile-filter-open", this.isMobileLayout && this.filterMenuOpen);
    this.elements.filterToggleButton.setAttribute("aria-expanded", String(this.filterMenuOpen));
    this.syncFilterButtonState();
    if (!this.filterMenuOpen) {
      this.hidePlayerFilterResults();
    }
  }

  handlePlayerFilterInput() {
    // Typing only drives the suggestion dropdown; the selected players live
    // in the chip list and are unaffected until a chip is removed.
    const rawQuery = this.elements.filterPlayerInput.value.trim();
    if (!rawQuery) {
      this.playerFilterMatches = [];
      this.playerFilterActiveIndex = -1;
      this.hidePlayerFilterResults();
      return;
    }

    this.playerFilterMatches = this.getPlayerFilterMatches(rawQuery);
    this.playerFilterActiveIndex = this.playerFilterMatches.length ? 0 : -1;
    this.renderPlayerFilterResults();
  }

  handlePlayerFilterFocus() {
    const rawQuery = this.elements.filterPlayerInput.value.trim();
    if (!rawQuery || this.elements.filterPlayerInput.disabled) {
      this.hidePlayerFilterResults();
      return;
    }

    this.playerFilterMatches = this.getPlayerFilterMatches(rawQuery);
    this.playerFilterActiveIndex = this.playerFilterMatches.length ? 0 : -1;
    this.renderPlayerFilterResults();
  }

  handlePlayerFilterInputTap() {
    if (!this.isMobileLayout || !this.filterMenuOpen) {
      return;
    }

    const value = this.elements.filterPlayerInput.value;
    if (!value) {
      return;
    }

    window.setTimeout(() => {
      if (document.activeElement !== this.elements.filterPlayerInput) {
        return;
      }

      this.elements.filterPlayerInput.setSelectionRange(0, value.length);
    }, 0);
  }

  handlePlayerFilterKeyDown(event) {
    if (event.key === "ArrowDown" && this.playerFilterMatches.length) {
      event.preventDefault();
      this.playerFilterActiveIndex = (this.playerFilterActiveIndex + 1) % this.playerFilterMatches.length;
      this.syncPlayerFilterActiveResult();
      return;
    }

    if (event.key === "ArrowUp" && this.playerFilterMatches.length) {
      event.preventDefault();
      this.playerFilterActiveIndex =
        (this.playerFilterActiveIndex - 1 + this.playerFilterMatches.length) % this.playerFilterMatches.length;
      this.syncPlayerFilterActiveResult();
      return;
    }

    if (event.key === "Escape") {
      this.hidePlayerFilterResults();
      return;
    }

    if (event.key !== "Enter") {
      return;
    }

    event.preventDefault();
    const selectedMatch =
      this.playerFilterMatches[this.playerFilterActiveIndex] || this.playerFilterMatches[0] || null;
    if (selectedMatch) {
      this.selectPlayerFilterResult(selectedMatch);
    }
  }

  getPlayerFilterMatches(query) {
    const selectedIds = new Set(this.filterState.players.map((player) => Number(player.ownerId)));
    return this.getRankedSearchMatches(this.playerFilterEntries, query)
      .filter((entry) => !selectedIds.has(Number(entry.ownerId)));
  }

  renderPlayerFilterResults() {
    this.renderSearchResultsDropdown({
      resultsEl: this.elements.filterPlayerResults,
      inputEl: this.elements.filterPlayerInput,
      matches: this.playerFilterMatches,
      activeIndex: this.playerFilterActiveIndex,
      uiState: this.searchResultsUi.filterPlayer,
      shouldStayClosed: false,
      onHover: (index) => {
        this.playerFilterActiveIndex = index;
        this.syncPlayerFilterActiveResult();
      },
      onSelect: (entry) => this.selectPlayerFilterResult(entry),
    });
  }

  hidePlayerFilterResults() {
    this.setSearchResultsOpen(this.elements.filterPlayerResults, false, this.searchResultsUi.filterPlayer);
  }

  syncPlayerFilterActiveResult() {
    this.syncSearchActiveResult(this.elements.filterPlayerResults, this.playerFilterActiveIndex);
  }

  selectPlayerFilterResult(entry) {
    const ownerId = Number(entry?.ownerId || 0);
    if (ownerId <= 0) {
      return;
    }
    const players = this.filterState.players.some((player) => Number(player.ownerId) === ownerId)
      ? this.filterState.players
      : [...this.filterState.players, { ownerId, username: String(entry.username || "").trim() }];
    this.filterState = { ...this.filterState, players };
    // The input is a picker, not the filter itself: clear it for the next
    // name so several players can be added in a row.
    this.elements.filterPlayerInput.value = "";
    this.playerFilterMatches = [];
    this.playerFilterActiveIndex = -1;
    this.renderFilterOptions();
    this.applyFilters();
    this.hidePlayerFilterResults();
  }

  removePlayerFilter(ownerId) {
    const id = Number(ownerId || 0);
    const players = this.filterState.players.filter((player) => Number(player.ownerId) !== id);
    if (players.length === this.filterState.players.length) {
      return;
    }
    this.filterState = { ...this.filterState, players };
    this.renderFilterOptions();
    this.applyFilters();
  }

  handleFilterOptionChange(event) {
    const input = event.target;
    if (!(input instanceof HTMLInputElement)) {
      return;
    }

    const group = input.dataset.group;
    if (!group || !["types", "kits", "heights", "owners", "tribes", "flingerOf"].includes(group)) {
      return;
    }

    const nextValues = new Set(this.filterState[group]);
    const rawValue = input.value;
    if (input.checked) {
      nextValues.add(rawValue);
    } else {
      nextValues.delete(rawValue);
    }

    this.filterState = {
      ...this.filterState,
      [group]: [...nextValues].sort((left, right) => {
        if (typeof left === "number" && typeof right === "number") {
          return left - right;
        }
        return String(left).localeCompare(String(right));
      }),
    };

    if (this.typesExcludePlayerBases()) {
      // Only wild bases remain visible, so a player filter can never match:
      // drop the selected players rather than silently filtering to nothing.
      this.filterState = { ...this.filterState, players: [] };
      this.playerFilterMatches = [];
      this.playerFilterActiveIndex = -1;
      this.elements.filterPlayerInput.value = "";
      this.hidePlayerFilterResults();
    }

    this.renderFilterOptions();
    this.applyFilters();
  }

  handleLevelRangeInput(event) {
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || !this.availableFilterLevels.length) {
      return;
    }

    let minIndex = Number.parseInt(this.elements.filterLevelMinInput.value, 10);
    let maxIndex = Number.parseInt(this.elements.filterLevelMaxInput.value, 10);
    if (Number.isNaN(minIndex)) {
      minIndex = 0;
    }
    if (Number.isNaN(maxIndex)) {
      maxIndex = this.availableFilterLevels.length - 1;
    }

    if (input.dataset.bound === "min" && minIndex > maxIndex) {
      maxIndex = minIndex;
      this.elements.filterLevelMaxInput.value = String(maxIndex);
    } else if (input.dataset.bound === "max" && maxIndex < minIndex) {
      minIndex = maxIndex;
      this.elements.filterLevelMinInput.value = String(minIndex);
    }

    const selectedMinLevel = this.availableFilterLevels[minIndex] ?? this.availableFilterLevels[0];
    const selectedMaxLevel =
      this.availableFilterLevels[maxIndex] ?? this.availableFilterLevels[this.availableFilterLevels.length - 1];
    const availableMinLevel = this.availableFilterLevels[0];
    const availableMaxLevel = this.availableFilterLevels[this.availableFilterLevels.length - 1];

    this.filterState = {
      ...this.filterState,
      levelMin: selectedMinLevel > availableMinLevel ? selectedMinLevel : null,
      levelMax: selectedMaxLevel < availableMaxLevel ? selectedMaxLevel : null,
    };

    this.renderLevelFilterControls(!this.elements.filterToggleButton.disabled);
    this.applyFilters();
  }

  handleOutpostFilterInput(event) {
    if (!this.availableOutpostMax) {
      return;
    }

    let minOutposts = Number.parseInt(this.elements.filterOutpostInput.value, 10);
    let maxOutposts = Number.parseInt(this.elements.filterOutpostMaxInput.value, 10);
    if (Number.isNaN(minOutposts) || minOutposts < 0) {
      minOutposts = 0;
    }
    if (Number.isNaN(maxOutposts)) {
      maxOutposts = this.availableOutpostMax;
    }
    minOutposts = Math.min(minOutposts, this.availableOutpostMax);
    maxOutposts = Math.min(Math.max(maxOutposts, 0), this.availableOutpostMax);

    const bound = event?.target?.dataset?.bound;
    if (bound === "min" && minOutposts > maxOutposts) {
      maxOutposts = minOutposts;
      this.elements.filterOutpostMaxInput.value = String(maxOutposts);
    } else if (bound === "max" && maxOutposts < minOutposts) {
      minOutposts = maxOutposts;
      this.elements.filterOutpostInput.value = String(minOutposts);
    }

    this.filterState = {
      ...this.filterState,
      outpostMin: minOutposts > 0 ? minOutposts : null,
      // Slider parked at the top means "no upper bound"; anywhere else -
      // including 0, the mains-only little fish - is a real bound.
      outpostMax: maxOutposts < this.availableOutpostMax ? maxOutposts : null,
    };

    this.renderOutpostFilterControls(!this.elements.filterToggleButton.disabled);
    this.applyFilters();
  }

  renderOutpostFilterControls(enabled) {
    if (!this.elements.filterOutpostRange) return;
    const section = this.elements.filterOutpostRange.closest(".filter-card, .filter-section");
    const rangeEnabled = enabled && this.availableOutpostMax > 0;

    if (section) {
      section.classList.toggle("disabled", !rangeEnabled);
    }
    this.elements.filterOutpostRange.classList.toggle("disabled", !rangeEnabled);
    this.elements.filterOutpostInput.disabled = !rangeEnabled;

    if (!rangeEnabled) {
      for (const input of [this.elements.filterOutpostInput, this.elements.filterOutpostMaxInput]) {
        input.min = "0";
        input.max = "0";
        input.value = "0";
        input.disabled = true;
      }
      this.elements.filterOutpostLabel.textContent = "Min -";
      this.elements.filterOutpostMaxLabel.textContent = "Max -";
      this.elements.filterOutpostRangeFill.style.left = "0%";
      this.elements.filterOutpostRangeFill.style.width = "0%";
      this.elements.filterOutpostHelp.textContent = enabled
        ? "No player outposts explored yet. Pan or scan the map."
        : "Sign in to load outpost counts.";
      return;
    }

    const maxOutposts = this.availableOutpostMax;
    const selectedMin = Math.min(Number(this.filterState.outpostMin || 0), maxOutposts);
    const selectedMax = (this.filterState.outpostMax ?? null) !== null
      ? Math.min(Number(this.filterState.outpostMax), maxOutposts)
      : maxOutposts;

    for (const input of [this.elements.filterOutpostInput, this.elements.filterOutpostMaxInput]) {
      input.min = "0";
      input.max = String(maxOutposts);
      input.disabled = false;
    }
    this.elements.filterOutpostInput.value = String(selectedMin);
    this.elements.filterOutpostMaxInput.value = String(selectedMax);
    this.elements.filterOutpostLabel.textContent = selectedMin > 0
      ? `Min ${formatNumber(selectedMin)}`
      : "Min -";
    this.elements.filterOutpostMaxLabel.textContent = selectedMax < maxOutposts
      ? `Max ${formatNumber(selectedMax)}`
      : "Max -";

    const left = maxOutposts > 0 ? (selectedMin / maxOutposts) * 100 : 0;
    const width = maxOutposts > 0 ? ((selectedMax - selectedMin) / maxOutposts) * 100 : 0;
    this.elements.filterOutpostRangeFill.style.left = `${left}%`;
    this.elements.filterOutpostRangeFill.style.width = `${Math.max(0, width)}%`;

    const hasMin = selectedMin > 0;
    const hasMax = selectedMax < maxOutposts;
    this.elements.filterOutpostHelp.textContent = hasMin && hasMax
      ? `Showing players holding ${formatNumber(selectedMin)}\u2013${formatNumber(selectedMax)} outposts (their mains and outposts).`
      : hasMin
        ? `Showing players holding at least ${formatNumber(selectedMin)} outpost${selectedMin === 1 ? "" : "s"}.`
        : hasMax
          ? `Showing players holding at most ${formatNumber(selectedMax)} outpost${selectedMax === 1 ? "" : "s"} - the little fish.`
          : "Showing players of every size.";
  }

  // Pushes filterState.inactivityDays back into the checkbox/slider (used on
  // restore and clear; user interaction flows the other way via
  // syncInactivityFilter). Kicks the activity-data load when active so the
  // restored filter actually filters.
  syncInactivityUi() {
    const days = Number(this.filterState?.inactivityDays || 0);
    if (this.elements.filterInactivityEnabled) {
      this.elements.filterInactivityEnabled.checked = days > 0;
    }
    if (this.elements.filterInactivityDays && days > 0) {
      this.elements.filterInactivityDays.value = String(days);
    }
    if (this.elements.filterInactivityLabel) {
      this.elements.filterInactivityLabel.textContent =
        `${days > 0 ? days : Number(this.elements.filterInactivityDays?.value || 30)}+ days`;
    }
    if (days > 0) {
      this.ensureWorldActivity().then(() => this.applyFilters()).catch(() => {});
    }
  }

  // ---- inactivity filter ------------------------------------------------
  syncInactivityFilter() {
    const enabled = Boolean(this.elements.filterInactivityEnabled?.checked);
    const days = Number(this.elements.filterInactivityDays?.value || 30);
    if (this.elements.filterInactivityLabel) {
      this.elements.filterInactivityLabel.textContent = `${days}+ days`;
    }
    this.filterState.inactivityDays = enabled ? days : null;
    if (enabled) {
      this.ensureWorldActivity().then(() => this.applyFilters()).catch(() => this.applyFilters());
    } else {
      this.applyFilters();
    }
  }

  // Per-world "outpost count last increased" timestamps, cached 10 minutes.
  async ensureWorldActivity() {
    // Scope to the world actually on screen (live or guest-cached), not the
    // Worlds-menu highlight: selectedWorldId defaults to the most populated
    // world, which may not be the one whose bases are being filtered.
    const world = String(this.viewedWorldId || this.session?.map?.worldid || "");
    if (!world) {
      return;
    }
    const cached = this.worldActivity;
    if (cached && cached.world === world && Date.now() - cached.fetchedAt < 10 * 60 * 1000) {
      return;
    }
    const payload = await fetchWorldActivity(world);
    this.worldActivity = {
      world,
      players: payload?.players || {},
      fetchedAt: Date.now(),
    };
  }

  buildRendererFilter() {
    const minOutposts = Number(this.filterState.outpostMin || 0);
    const maxOutposts = this.filterState.outpostMax ?? null;
    let bigOwners = null;
    if (minOutposts > 0 || maxOutposts !== null) {
      bigOwners = new Set();
      for (const [owner, count] of this.ownerOutpostCounts) {
        if (count >= minOutposts && (maxOutposts === null || count <= maxOutposts)) {
          bigOwners.add(owner);
        }
      }
    }
    const days = Number(this.filterState.inactivityDays || 0);
    let inactiveNames = null;
    if (days > 0) {
      const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
      const players = (this.worldActivity && this.worldActivity.players) || {};
      inactiveNames = new Set();
      for (const [low, incMs] of Object.entries(players)) {
        if (Number(incMs || 0) > 0 && Number(incMs) <= cutoff) {
          inactiveNames.add(low);
        }
      }
    }
    // Checklist -> renderer set: all boxes checked means the restriction is
    // off (empty set); no boxes checked means "match nothing", expressed as
    // a sentinel key no cell can carry.
    const checklistToSet = (selected, allKeys) => {
      if (selected.length >= allKeys.length) return [];
      if (selected.length === 0) return ["__none__"];
      return selected;
    };
    const heights = checklistToSet(this.filterState.heights || ALL_HEIGHT_FILTER_KEYS, ALL_HEIGHT_FILTER_KEYS);
    const owners = checklistToSet(this.filterState.owners || ALL_OWNER_FILTER_KEYS, ALL_OWNER_FILTER_KEYS);
    const tribes = checklistToSet(this.filterState.tribes || ALL_TRIBE_FILTER_KEYS, ALL_TRIBE_FILTER_KEYS);
    const flingerOn = this.filterState.flingerEnabled === true
      && Number(this.filterState.flingerOf?.length || 0) > 0;
    const relSets = (owners.length > 0 || flingerOn) ? this.buildOwnerRelationSets() : null;
    const flingerCells = flingerOn
      ? this.buildFlingerRangeMask(this.filterState.flingerOf, relSets)
      : null;
    return {
      ...this.filterState,
      types: checklistToSet(this.filterState.types, ALL_TYPE_FILTER_KEYS),
      kits: checklistToSet(this.filterState.kits, ALL_KIT_FILTER_KEYS),
      heights,
      owners,
      tribes,
      relSets,
      flingerCells,
      inactiveNames,
      bigOwners,
    };
  }

  // Lowercased-name sets the renderer uses to resolve me/allies/enemies.
  buildOwnerRelationSets() {
    const own = new Set();
    const ownName = String(this.session?.user?.username || "").trim().toLocaleLowerCase();
    if (ownName) own.add(ownName);
    const allies = new Set();
    for (const name of this.allianceMemberMeta?.keys() || []) {
      if (name && !own.has(name)) allies.add(name);
    }
    const enemies = new Set(this.allianceEnemyLower || []);
    return { own, allies, enemies };
  }

  // Reach of the chosen anchor groups, straight from the renderer's verbatim
  // GetCellsInRange port (odd-q -> axial hex disk, water excluded) - the
  // same iteration that draws the own-range rings. Rebuilt on every filter
  // apply, so zones explored later fold in on the next change.
  buildFlingerRangeMask(groups, relSets) {
    return this.renderer?.computeFlingerReachFor(groups, relSets) || new Set();
  }

  // ---- help panel + hide requests --------------------------------------
  openHelpPanel() {
    this.elements.helpPanel.hidden = false;
    this.refreshHideRequestArea().catch(() => {});
  }

  async refreshHideRequestArea() {
    const status = this.elements.hideRequestStatus;
    const form = this.elements.hideRequestForm;
    if (!status || !form) {
      return;
    }
    if (!this.session) {
      status.textContent = "Sign in to request hiding for your account.";
      form.hidden = true;
      return;
    }
    try {
      const payload = await fetchHideRequestStatus();
      this.adoptRefreshedToken(payload?.token);
      if (payload?.alreadyHidden) {
        status.textContent = "Your bases are already hidden from normal users.";
        form.hidden = true;
        return;
      }
      const request = payload?.request;
      if (request?.status === "pending") {
        status.textContent = "Your hiding request is pending admin review.";
        form.hidden = true;
        return;
      }
      if (request?.status === "denied") {
        status.textContent = "Your previous request was denied. You may submit a new one.";
        form.hidden = false;
        return;
      }
      status.textContent = "";
      form.hidden = false;
    } catch (error) {
      debugLog("Hide request status failed.", error);
      status.textContent = "Could not load your hiding status right now.";
      form.hidden = true;
    }
  }

  async submitHideRequest() {
    const reason = String(this.elements.hideRequestReason?.value || "").trim();
    const status = this.elements.hideRequestStatus;
    if (!reason) {
      status.textContent = "Please give a short reason.";
      return;
    }
    try {
      const payload = await submitHideRequest(reason);
      this.adoptRefreshedToken(payload?.token);
      this.elements.hideRequestReason.value = "";
      status.textContent = "Request submitted - an admin will review it.";
      this.elements.hideRequestForm.hidden = true;
    } catch (error) {
      status.textContent = error?.message || "Could not submit the request.";
    }
  }

  clearFilters() {
    this.filterState = createEmptyBaseFilter();
    this.syncInactivityUi();
    this.renderFilterOptions();
    this.applyFilters();
  }

  applyFilters() {
    this.renderer?.setBaseFilter(this.buildRendererFilter());
    this.syncFilterButtonState();
    this.updateFilterStatus(true);
    this.updateFilterMatchCount(true);
    this.saveFilterState();
  }

  saveFilterState() {
    if (!this.session || !this.userSettings) {
      return;
    }

    // v: 2 marks the explicit-checklist model. Older blobs stored [] to
    // mean "all types"; without the marker that would now read as "none".
    this.userSettings.filters[this.getWorldSettingsKey()] = { ...this.filterState, v: 2 };
    this.scheduleSaveUserSettings();
  }

  loadFilterState() {
    try {
      const parsed = this.userSettings?.filters?.[this.getWorldSettingsKey()] || null;
      if (!parsed || typeof parsed !== "object") {
        return false;
      }

      const isV2 = Number(parsed.v || 0) >= 2;
      const readChecklist = (value, allKeys) => {
        const list = Array.isArray(value)
          ? value.map(String).filter((key) => allKeys.includes(key))
          : [];
        // Legacy blobs used [] for "no restriction"; v2 stores every key
        // explicitly and [] genuinely means "none checked".
        if (!isV2 && list.length === 0) return [...allKeys];
        return list;
      };
      // Legacy single player selection migrates into the multi-player list.
      let players = Array.isArray(parsed.players)
        ? parsed.players
          .map((entry) => ({
            ownerId: Number(entry?.ownerId || 0),
            username: String(entry?.username || "").trim(),
          }))
          .filter((entry) => entry.ownerId > 0)
        : [];
      if (!players.length && Number(parsed.playerOwnerId || 0) > 0) {
        players = [{
          ownerId: Number(parsed.playerOwnerId),
          username: String(parsed.playerUsername || "").trim(),
        }];
      }
      const readSubset = (value, allKeys) => (Array.isArray(value)
        ? value.map(String).filter((key) => allKeys.includes(key))
        : []);
      this.filterState = {
        ...createEmptyBaseFilter(),
        types: readChecklist(parsed.types, ALL_TYPE_FILTER_KEYS),
        kits: parsed.kits !== undefined
          ? readChecklist(parsed.kits, ALL_KIT_FILTER_KEYS)
          : [...ALL_KIT_FILTER_KEYS],
        heights: parsed.heights !== undefined
          ? readChecklist(parsed.heights, ALL_HEIGHT_FILTER_KEYS)
          : [...ALL_HEIGHT_FILTER_KEYS],
        owners: parsed.owners !== undefined
          ? readChecklist(parsed.owners, ALL_OWNER_FILTER_KEYS)
          : [...ALL_OWNER_FILTER_KEYS],
        tribes: parsed.tribes !== undefined
          ? readChecklist(parsed.tribes, ALL_TRIBE_FILTER_KEYS)
          : [...ALL_TRIBE_FILTER_KEYS],
        flingerEnabled: parsed.flingerEnabled === true,
        flingerOf: readSubset(parsed.flingerOf, ALL_OWNER_FILTER_KEYS),
        damageMin: Number(parsed.damageMin || 0) > 0 ? Number(parsed.damageMin) : null,
        damageMax: (parsed.damageMax ?? null) !== null && Number(parsed.damageMax) < 100
          ? Math.max(0, Number(parsed.damageMax)) : null,
        protection: parsed.protection !== undefined
          ? readChecklist(parsed.protection, ALL_PROTECTION_FILTER_KEYS)
          : [...ALL_PROTECTION_FILTER_KEYS],
        levelMin: Number(parsed.levelMin || 0) > 0 ? Number(parsed.levelMin) : null,
        levelMax: Number(parsed.levelMax || 0) > 0 ? Number(parsed.levelMax) : null,
        // The outpost-count range was removed outright; its saved values are
        // dropped so an old blob cannot silently filter without UI.
        outpostMin: null,
        outpostMax: null,
        players,
        inactivityDays: Number(parsed.inactivityDays || 0) > 0 ? Number(parsed.inactivityDays) : null,
      };
      this.syncInactivityUi();
      debugLog("Restored saved filters:", this.filterState);
      return true;
    } catch (error) {
      console.warn("[BYM-MR2] Failed to load filters.", error);
      return false;
    }
  }

  handleDamageRangeInput() {
    const minInput = this.elements.filterDamageMinInput;
    const maxInput = this.elements.filterDamageMaxInput;
    if (!minInput || !maxInput) return;
    let min = Math.max(0, Math.min(100, Number(minInput.value) || 0));
    let max = Math.max(0, Math.min(100, Number(maxInput.value) || 0));
    if (min > max) [min, max] = [max, min];
    this.filterState = {
      ...this.filterState,
      damageMin: min > 0 ? min : null,
      damageMax: max < 100 ? max : null,
    };
    this.syncDamageRangeUi();
    this.updateFilterCardHeaders();
    this.applyFilters();
  }

  syncDamageRangeUi() {
    const minInput = this.elements.filterDamageMinInput;
    const maxInput = this.elements.filterDamageMaxInput;
    if (!minInput || !maxInput) return;
    const min = Number(this.filterState.damageMin || 0);
    const max = this.filterState.damageMax === null || this.filterState.damageMax === undefined
      ? 100 : Number(this.filterState.damageMax);
    minInput.value = String(min);
    maxInput.value = String(max);
    if (this.elements.filterDamageMinLabel) this.elements.filterDamageMinLabel.textContent = `Min ${min}%`;
    if (this.elements.filterDamageMaxLabel) this.elements.filterDamageMaxLabel.textContent = `Max ${max}%`;
    if (this.elements.filterDamageFill) {
      this.elements.filterDamageFill.style.left = `${min}%`;
      this.elements.filterDamageFill.style.width = `${Math.max(0, max - min)}%`;
    }
  }

  // Per-card reset: clears just that card's slice of the filter state.
  resetFilterCard(card) {
    const empty = createEmptyBaseFilter();
    const slices = {
      player: ["players"],
      cell: ["types", "heights"],
      outposts: ["kits", "owners"],
      wild: ["tribes", "levelMin", "levelMax"],
      damage: ["damageMin", "damageMax", "protection"],
      misc: ["flingerEnabled", "flingerOf", "inactivityDays"],
    };
    const keys = slices[card];
    if (!keys) return;
    const next = { ...this.filterState };
    for (const key of keys) next[key] = empty[key];
    this.filterState = next;
    this.syncInactivityUi();
    this.renderFilterOptions();
    this.applyFilters();
  }

  // B4 header state: "all" (hidden badge) when a card is idle, "N active"
  // plus a reset link when any of its sub-filters bite.
  updateFilterCardHeaders() {
    const state = this.filterState;
    const subsetActive = (list, all) => Array.isArray(list) && list.length < all.length;
    const counts = {
      player: [state.players?.length > 0],
      cell: [subsetActive(state.types, ALL_TYPE_FILTER_KEYS),
             subsetActive(state.heights, ALL_HEIGHT_FILTER_KEYS)],
      outposts: [subsetActive(state.kits, ALL_KIT_FILTER_KEYS),
                 subsetActive(state.owners, ALL_OWNER_FILTER_KEYS)],
      wild: [subsetActive(state.tribes, ALL_TRIBE_FILTER_KEYS),
             Number(state.levelMin || 0) > 0 || Number(state.levelMax || 0) > 0],
      damage: [Number(state.damageMin || 0) > 0
                 || (state.damageMax !== null && state.damageMax !== undefined),
               subsetActive(state.protection, ALL_PROTECTION_FILTER_KEYS)],
      misc: [state.flingerEnabled === true && (state.flingerOf?.length || 0) > 0,
             Number(state.inactivityDays || 0) > 0],
    };
    for (const [card, flags] of Object.entries(counts)) {
      const root = document.querySelector(`.filter-card[data-card="${card}"]`);
      if (!root) continue;
      const active = flags.filter(Boolean).length;
      const badge = root.querySelector(".filter-card-badge");
      const reset = root.querySelector(".filter-card-reset");
      if (badge) {
        badge.hidden = active === 0;
        badge.textContent = `${active} active`;
      }
      if (reset) reset.hidden = active === 0;
    }
  }

  renderFilterOptions() {
    const filterEnabled = !this.elements.filterToggleButton.disabled;
    this.renderPlayerFilterOptions(filterEnabled && !this.typesExcludePlayerBases());
    this.renderFilterGroup(this.elements.filterTypeOptions, "types", TYPE_FILTER_OPTIONS, filterEnabled);
    // Kits constrain outposts only, including a filtered player's outposts,
    // so unlike the old tribe section this stays enabled with a player list.
    this.renderFilterGroup(this.elements.filterKitOptions, "kits", KIT_FILTER_OPTIONS, filterEnabled);
    if (this.elements.filterHeightOptions) {
      this.renderFilterGroup(this.elements.filterHeightOptions, "heights", HEIGHT_FILTER_OPTIONS, filterEnabled);
    }
    if (this.elements.filterOwnerOptions) {
      this.renderFilterGroup(this.elements.filterOwnerOptions, "owners", OWNER_FILTER_OPTIONS, filterEnabled);
    }
    if (this.elements.filterTribeOptions) {
      this.renderFilterGroup(this.elements.filterTribeOptions, "tribes", TRIBE_FILTER_OPTIONS, filterEnabled);
    }
    if (this.elements.filterFlingerEnabled) {
      this.elements.filterFlingerEnabled.checked = this.filterState.flingerEnabled === true;
      this.elements.filterFlingerEnabled.disabled = !filterEnabled;
    }
    if (this.elements.filterFlingerOptions) {
      // Anchor chips light up only while the master checkbox is on. Unlike
      // the other checklists these default to unchecked: empty means the
      // flinger filter is idle, not "match nothing".
      this.renderFilterGroup(
        this.elements.filterFlingerOptions, "flingerOf", OWNER_FILTER_OPTIONS,
        filterEnabled && this.filterState.flingerEnabled === true);
    }
    this.renderLevelFilterControls(filterEnabled);
    this.renderOutpostFilterControls(filterEnabled);
    this.syncDamageRangeUi();
    if (this.elements.filterDamageMinInput) this.elements.filterDamageMinInput.disabled = !filterEnabled;
    if (this.elements.filterDamageMaxInput) this.elements.filterDamageMaxInput.disabled = !filterEnabled;
    const protection = Array.isArray(this.filterState.protection)
      ? this.filterState.protection : ALL_PROTECTION_FILTER_KEYS;
    if (this.elements.filterProtectionYes) {
      this.elements.filterProtectionYes.checked = protection.includes("protected");
      this.elements.filterProtectionYes.disabled = !filterEnabled;
    }
    if (this.elements.filterProtectionNo) {
      this.elements.filterProtectionNo.checked = protection.includes("unprotected");
      this.elements.filterProtectionNo.disabled = !filterEnabled;
    }
    this.updateFilterCardHeaders();
    this.elements.filterClearButton.disabled = !hasActiveBaseFilterState(this.filterState);
  }

  renderPlayerFilterOptions(enabled) {
    const section = this.elements.filterPlayerInput.closest(".filter-card, .filter-section");
    const shell = this.elements.filterPlayerInput.closest(".filter-player-shell");
    this.elements.filterPlayerInput.disabled = !enabled;
    if (section) {
      section.classList.toggle("disabled", !enabled);
    }
    if (shell) {
      shell.classList.toggle("disabled", !enabled);
    }
    if (!enabled) {
      this.elements.filterPlayerInput.value = "";
    }
    this.elements.filterPlayerInput.placeholder = enabled
      ? (this.filterState.players.length ? "Add another player" : "Filter by username")
      : "No player bases are shown";

    // Selected players as removable chips under the input.
    const list = this.elements.filterPlayerList;
    if (list) {
      list.replaceChildren();
      list.hidden = this.filterState.players.length === 0;
      for (const player of this.filterState.players) {
        const chip = document.createElement("span");
        chip.className = "filter-player-chip";
        const name = document.createElement("span");
        name.className = "filter-player-chip-name";
        name.textContent = String(player.username || "").trim() || `#${player.ownerId}`;
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "filter-player-chip-remove";
        remove.setAttribute("aria-label", `Remove ${name.textContent} from the filter`);
        remove.title = "Remove";
        remove.textContent = "\u00d7";
        remove.disabled = !enabled;
        remove.addEventListener("click", () => this.removePlayerFilter(player.ownerId));
        chip.append(name, remove);
        list.appendChild(chip);
      }
    }

    if (
      !enabled ||
      !this.elements.filterPlayerInput.value.trim() ||
      !this.elements.filterPlayerInput.matches(":focus")
    ) {
      this.hidePlayerFilterResults();
    }
  }

  renderFilterGroup(container, group, options, enabled) {
    container.replaceChildren();
    container.classList.toggle("disabled", !enabled);
    // Only legacy .filter-section wrappers gray as a whole. B4 cards hold
    // several groups whose enabled states differ (the flinger chips are
    // gated on their master checkbox), so the card itself never grays here.
    const section = container.closest(".filter-section");
    if (section) {
      section.classList.toggle("disabled", !enabled);
    }

    for (const option of options) {
      const label = document.createElement("label");
      const input = document.createElement("input");
      const text = document.createElement("span");
      const optionValue = option.key;
      const isChecked = this.filterState[group].includes(optionValue);

      label.className = `filter-chip${isChecked ? " active" : ""}${!enabled ? " disabled" : ""}`;
      input.type = "checkbox";
      input.value = String(optionValue);
      input.dataset.group = group;
      input.checked = isChecked;
      input.disabled = !enabled;
      text.textContent = option.label;

      label.append(input, text);
      container.appendChild(label);
    }
  }

  renderLevelFilterControls(enabled) {
    if (!this.elements.filterLevelRange) return;
    const rangeEnabled = enabled && this.availableFilterLevels.length > 0;
    // Gray only the slider block itself: the Wild card also holds the tribe
    // chips, which stay live even when no levels are known yet.
    this.elements.filterLevelRange.classList.toggle("disabled", !rangeEnabled);
    this.elements.filterLevelRange.classList.toggle("disabled", !rangeEnabled);
    this.elements.filterLevelMinInput.disabled = !rangeEnabled;
    this.elements.filterLevelMaxInput.disabled = !rangeEnabled;

    if (!rangeEnabled) {
      this.elements.filterLevelMinInput.min = "0";
      this.elements.filterLevelMinInput.max = "0";
      this.elements.filterLevelMinInput.value = "0";
      this.elements.filterLevelMaxInput.min = "0";
      this.elements.filterLevelMaxInput.max = "0";
      this.elements.filterLevelMaxInput.value = "0";
      this.elements.filterLevelMinLabel.textContent = "Min -";
      this.elements.filterLevelMaxLabel.textContent = "Max -";
      this.elements.filterLevelRangeFill.style.left = "0%";
      this.elements.filterLevelRangeFill.style.width = "0%";
      this.elements.filterLevelHelp.textContent = enabled
        ? "No wild base levels available."
        : "Sign in to load filter levels.";
      return;
    }

    const levelState = this.getLevelFilterDisplayState();
    const maxIndex = this.availableFilterLevels.length - 1;
    this.elements.filterLevelMinInput.min = "0";
    this.elements.filterLevelMinInput.max = String(maxIndex);
    this.elements.filterLevelMinInput.value = String(levelState.minIndex);
    this.elements.filterLevelMaxInput.min = "0";
    this.elements.filterLevelMaxInput.max = String(maxIndex);
    this.elements.filterLevelMaxInput.value = String(levelState.maxIndex);
    this.elements.filterLevelMinLabel.textContent = `Min ${formatNumber(levelState.minLevel)}`;
    this.elements.filterLevelMaxLabel.textContent = `Max ${formatNumber(levelState.maxLevel)}`;

    const denominator = Math.max(1, maxIndex);
    const leftPercent = maxIndex > 0 ? (levelState.minIndex / denominator) * 100 : 0;
    const rightPercent = maxIndex > 0 ? (levelState.maxIndex / denominator) * 100 : 100;
    this.elements.filterLevelRangeFill.style.left = `${leftPercent}%`;
    this.elements.filterLevelRangeFill.style.width = `${Math.max(0, rightPercent - leftPercent)}%`;
    this.elements.filterLevelHelp.textContent = this.buildLevelRangeSummary(levelState.minLevel, levelState.maxLevel);
  }

  getLevelFilterDisplayState() {
    if (!this.availableFilterLevels.length) {
      return {
        minIndex: 0,
        maxIndex: 0,
        minLevel: null,
        maxLevel: null,
      };
    }

    const availableMinLevel = this.availableFilterLevels[0];
    const availableMaxLevel = this.availableFilterLevels[this.availableFilterLevels.length - 1];
    const requestedMinLevel = Number(this.filterState.levelMin || 0) > 0
      ? Number(this.filterState.levelMin)
      : availableMinLevel;
    const requestedMaxLevel = Number(this.filterState.levelMax || 0) > 0
      ? Number(this.filterState.levelMax)
      : availableMaxLevel;

    let minIndex = this.availableFilterLevels.findIndex((level) => level >= requestedMinLevel);
    if (minIndex === -1) {
      minIndex = this.availableFilterLevels.length - 1;
    }

    let maxIndex = this.availableFilterLevels.length - 1;
    while (maxIndex > 0 && this.availableFilterLevels[maxIndex] > requestedMaxLevel) {
      maxIndex -= 1;
    }

    if (minIndex > maxIndex) {
      minIndex = maxIndex;
    }

    return {
      minIndex,
      maxIndex,
      minLevel: this.availableFilterLevels[minIndex],
      maxLevel: this.availableFilterLevels[maxIndex],
    };
  }

  buildLevelRangeSummary(minLevel, maxLevel) {
    if (minLevel === null || maxLevel === null) {
      return "No wild base levels available.";
    }

    if (
      minLevel === this.availableFilterLevels[0] &&
      maxLevel === this.availableFilterLevels[this.availableFilterLevels.length - 1]
    ) {
      return "Showing all available levels.";
    }

    if (minLevel === maxLevel) {
      return `Showing level ${formatNumber(minLevel)}.`;
    }

    return `Showing levels ${formatNumber(minLevel)}-${formatNumber(maxLevel)}.`;
  }

  updateFilterMatchCount(isEnabled) {
    if (!this.elements.filterMatchCount) {
      return;
    }

    if (!isEnabled || !this.renderer) {
      this.elements.filterMatchCount.textContent = "Sign in to load base count.";
      return;
    }

    const count = this.renderer.getBaseFilterMatchCount({ includePlayerBases: true });
    this.elements.filterMatchCount.textContent = `${formatNumber(count)} base${count === 1 ? "" : "s"} shown`;
  }

  hasPlayerFilterQuery() {
    return (
      this.filterState.players.length > 0 ||
      Boolean(this.elements.filterPlayerInput.value.trim())
    );
  }

  // True when the type checklist leaves no player-owned base visible (only
  // wild checked, or nothing checked) - the states where a player filter is
  // meaningless.
  typesExcludePlayerBases() {
    return !this.filterState.types.includes("main") && !this.filterState.types.includes("outpost");
  }

  syncFilterButtonState() {
    // The button always reads "Filters"; active filters are indicated by the
    // highlighted (active) style rather than a changing label.
    const isActive = this.filterMenuOpen || hasActiveBaseFilterState(this.filterState);
    this.elements.filterToggleButton.classList.toggle("active", isActive);
    this.updateFilterToggleLabel("Filters");
  }

  updateFilterToggleLabel(label) {
    this.elements.filterToggleLabel.textContent = label;
    this.elements.filterToggleButton.setAttribute("aria-label", label);
    this.elements.filterToggleButton.title = label;
  }

  updateFilterStatus(isEnabled) {
    if (!this.elements.filterStatus) {
      return;
    }

    if (!isEnabled) {
      this.elements.filterStatus.textContent = "Sign in to enable base filters.";
      return;
    }

    if (!hasActiveBaseFilterState(this.filterState)) {
      this.elements.filterStatus.textContent = "Showing all visible bases.";
      return;
    }

    const segments = [];
    if (this.filterState.types.length < ALL_TYPE_FILTER_KEYS.length) {
      const labels = TYPE_FILTER_OPTIONS
        .filter((option) => this.filterState.types.includes(option.key))
        .map((option) => option.label);
      segments.push(labels.length ? `Type: ${labels.join(", ")}` : "Type: none");
    }

    if (this.filterState.kits.length < ALL_KIT_FILTER_KEYS.length) {
      const labels = KIT_FILTER_OPTIONS
        .filter((option) => this.filterState.kits.includes(option.key))
        .map((option) => option.label);
      segments.push(labels.length ? `Outpost type: ${labels.join(", ")}` : "Outpost type: none");
    }

    const checklistSegment = (selected, options, title) => {
      if (!Array.isArray(selected) || selected.length >= options.length) return;
      const labels = options
        .filter((option) => selected.includes(option.key))
        .map((option) => option.label);
      segments.push(labels.length ? `${title}: ${labels.join(", ")}` : `${title}: none`);
    };
    checklistSegment(this.filterState.heights, HEIGHT_FILTER_OPTIONS, "Cell height");
    checklistSegment(this.filterState.protection, PROTECTION_FILTER_OPTIONS, "Protection");
    if (Number(this.filterState.damageMin || 0) > 0
        || (this.filterState.damageMax !== null && this.filterState.damageMax !== undefined)) {
      const lo = Number(this.filterState.damageMin || 0);
      const hi = this.filterState.damageMax === null || this.filterState.damageMax === undefined
        ? 100 : Number(this.filterState.damageMax);
      segments.push(`Damage ${lo}-${hi}%`);
    }
    checklistSegment(this.filterState.owners, OWNER_FILTER_OPTIONS, "Owner");
    checklistSegment(this.filterState.tribes, TRIBE_FILTER_OPTIONS, "Tribe");
    if (this.filterState.flingerEnabled === true && this.filterState.flingerOf?.length) {
      const labels = OWNER_FILTER_OPTIONS
        .filter((option) => this.filterState.flingerOf.includes(option.key))
        .map((option) => option.label);
      segments.push(`In flinger range of: ${labels.join(", ")}`);
    }
    if (Number(this.filterState.inactivityDays || 0) > 0) {
      segments.push(`Inactive ${this.filterState.inactivityDays}+ days`);
    }

    if (Number(this.filterState.levelMin || 0) > 0 || Number(this.filterState.levelMax || 0) > 0) {
      const levelState = this.getLevelFilterDisplayState();
      if (levelState.minLevel !== null && levelState.maxLevel !== null) {
        segments.push(
          levelState.minLevel === levelState.maxLevel
            ? `Level: ${levelState.minLevel}`
            : `Levels: ${levelState.minLevel}-${levelState.maxLevel}`,
        );
      }
    }

    {
      const minOutposts = Number(this.filterState.outpostMin || 0);
      const maxOutposts = this.filterState.outpostMax ?? null;
      if (minOutposts > 0 && maxOutposts !== null) {
        segments.push(`Outposts: ${formatNumber(minOutposts)}\u2013${formatNumber(maxOutposts)}`);
      } else if (minOutposts > 0) {
        segments.push(`Outposts: ${formatNumber(minOutposts)}+`);
      } else if (maxOutposts !== null) {
        segments.push(`Outposts: \u2264${formatNumber(maxOutposts)}`);
      }
    }

    if (this.filterState.players.length) {
      const names = this.filterState.players
        .map((player) => String(player.username || "").trim())
        .filter(Boolean);
      segments.push(`Player${names.length === 1 ? "" : "s"}: ${names.join(", ")}`);
    }

    this.elements.filterStatus.textContent = segments.join(" | ");
  }

  // The Home button needs a live session on the player's own world; cached
  // guest views (signed in or not) have no home yard to centre on.
  updateFindHomeButtonState() {
    // Stays clickable for guests - the click prompts sign-in instead.
    this.elements.findHomeButton.disabled = false;
  }

  syncResponsiveLayout(isMobile) {
    const nextIsMobile = Boolean(isMobile);
    if (this.isMobileLayout === nextIsMobile) {
      this.syncSearchToggleButtonState();
      this.syncFilterButtonState();
      return;
    }

    this.isMobileLayout = nextIsMobile;
    this.elements.appRoot.classList.toggle("mobile-layout", this.isMobileLayout);

    // Crossing the breakpoint swaps menus between anchored dropdowns and
    // full-width sheets; whatever was open was positioned for the old mode.
    this.closeToolbarMenus();
    this.setMobileSearchOpen(false);
    this.setFilterMenuOpen(false);
    this.hideSearchResults();
    this.hidePlayerFilterResults();
    this.syncSearchToggleButtonState();
    this.syncFilterButtonState();
    this.syncMobileDetailsState();
    this.cancelDesktopDetailsResizeAnimation();
    if (this.elements.detailsPanel) {
      this.elements.detailsPanel.style.height = "";
    }
    this.renderer?.render();
  }

  syncDesktopDetailsState() {
    const panel = this.elements.detailsPanel;
    if (!panel) return;
    // Open when there is something to show: a selected cell, or a profile
    // opened from elsewhere in the app.
    const isOpen = Boolean(this.selectedCell) || Boolean(this.profileOwnerId);
    panel.classList.toggle("open", isOpen);
    panel.setAttribute("aria-hidden", String(!isOpen));
  }

  // Dismisses the cell popup on both layouts. clearSelection() drops the
  // renderer's selection and hover, fires onSelectCell(null) which re-renders
  // the panel, and repaints the map - so clicking the same cell again
  // re-opens it rather than the click being swallowed.
  closeCellDetails() {
    this.profileOwnerId = null;
    if (this.renderer) {
      this.renderer.clearSelection();
      return;
    }
    this.selectedCell = null;
    this.hoveredCell = null;
    this.renderDetails();
  }

  syncMobileDetailsState() {
    const isOpen = this.isMobileLayout && Boolean(this.selectedCell);
    this.elements.appRoot.classList.toggle("mobile-details-open", isOpen);
    this.elements.mobileDetailsSheet.setAttribute("aria-hidden", String(!isOpen));

    if (!isOpen) {
      this.cancelMobileDetailsResizeAnimation();
      this.elements.mobileDetailsSheet.style.height = "";
    }
  }

  animateDesktopDetailsResize(previousHeight, shouldAnimate) {
    const panel = this.elements.detailsPanel;
    if (!panel) {
      return;
    }

    this.cancelDesktopDetailsResizeAnimation();

    if (!shouldAnimate || this.isMobileLayout) {
      panel.style.height = "";
      return;
    }

    const nextHeight = panel.getBoundingClientRect().height;
    if (!previousHeight || Math.abs(nextHeight - previousHeight) < 1) {
      panel.style.height = "";
      return;
    }

    panel.style.height = `${previousHeight}px`;
    void panel.offsetHeight;

    this.desktopDetailsResizeFrame = window.requestAnimationFrame(() => {
      this.desktopDetailsResizeFrame = 0;
      panel.style.height = `${nextHeight}px`;
      this.desktopDetailsResizeTimer = window.setTimeout(() => {
        this.desktopDetailsResizeTimer = 0;
        if (!this.isMobileLayout) {
          panel.style.height = "";
        }
      }, DESKTOP_DETAILS_RESIZE_TRANSITION_MS);
    });
  }

  cancelDesktopDetailsResizeAnimation() {
    if (this.desktopDetailsResizeFrame) {
      window.cancelAnimationFrame(this.desktopDetailsResizeFrame);
      this.desktopDetailsResizeFrame = 0;
    }

    if (this.desktopDetailsResizeTimer) {
      window.clearTimeout(this.desktopDetailsResizeTimer);
      this.desktopDetailsResizeTimer = 0;
    }
  }

  handleMobileDetailsClose() {
    if (this.renderer) {
      this.renderer.clearSelection();
      return;
    }

    this.selectedCell = null;
    this.hoveredCell = null;
    this.renderDetails();
  }

  animateMobileDetailsResize(previousHeight, shouldAnimate) {
    const sheet = this.elements.mobileDetailsSheet;
    if (!sheet) {
      return;
    }

    this.cancelMobileDetailsResizeAnimation();

    if (
      !shouldAnimate ||
      !this.isMobileLayout ||
      !this.selectedCell ||
      !this.elements.appRoot.classList.contains("mobile-details-open")
    ) {
      sheet.style.height = "";
      return;
    }

    const nextHeight = sheet.getBoundingClientRect().height;
    if (!previousHeight || Math.abs(nextHeight - previousHeight) < 1) {
      sheet.style.height = "";
      return;
    }

    sheet.style.height = `${previousHeight}px`;
    void sheet.offsetHeight;

    this.mobileDetailsResizeFrame = window.requestAnimationFrame(() => {
      this.mobileDetailsResizeFrame = 0;
      sheet.style.height = `${nextHeight}px`;
      this.mobileDetailsResizeTimer = window.setTimeout(() => {
        this.mobileDetailsResizeTimer = 0;
        if (this.isMobileLayout && this.selectedCell) {
          sheet.style.height = "";
        }
      }, MOBILE_DETAILS_RESIZE_TRANSITION_MS);
    });
  }

  cancelMobileDetailsResizeAnimation() {
    if (this.mobileDetailsResizeFrame) {
      window.cancelAnimationFrame(this.mobileDetailsResizeFrame);
      this.mobileDetailsResizeFrame = 0;
    }

    if (this.mobileDetailsResizeTimer) {
      window.clearTimeout(this.mobileDetailsResizeTimer);
      this.mobileDetailsResizeTimer = 0;
    }
  }

  handleSearchToggle() {
    // Search lives in a centred game modal now, same chrome as Jump and
    // New Bookmark.
    if (this.elements.searchModal && !this.elements.searchModal.hidden) {
      this.closeModals();
      return;
    }
    this.closeToolbarMenus?.();
    this.hideBookmarkFlyout();
    if (this.elements.modalBlocker) this.elements.modalBlocker.hidden = false;
    if (this.elements.searchModal) this.elements.searchModal.hidden = false;
    window.setTimeout(() => this.elements.searchInput?.focus(), 30);
    this.renderSearchResults();
  }


  handleSearchInputTap() {
    if (!this.isMobileLayout || !this.mobileSearchOpen) {
      return;
    }

    const value = this.elements.searchInput.value;
    if (!value) {
      return;
    }

    window.setTimeout(() => {
      if (document.activeElement !== this.elements.searchInput) {
        return;
      }

      this.elements.searchInput.setSelectionRange(0, value.length);
    }, 0);
  }

  setMobileSearchOpen(isOpen, { focus = false } = {}) {
    const nextIsOpen = this.isMobileLayout && Boolean(isOpen);
    this.mobileSearchOpen = nextIsOpen;
    this.elements.appRoot.classList.toggle("mobile-search-open", this.mobileSearchOpen);
    this.syncSearchToggleButtonState();

    if (!this.mobileSearchOpen) {
      this.hideSearchResults();
      if (document.activeElement === this.elements.searchInput) {
        this.elements.searchInput.blur();
      }
      return;
    }

    if (focus) {
      window.setTimeout(() => this.elements.searchInput.focus(), 0);
    }
  }

  syncSearchToggleButtonState() {
    const isOpen = this.isMobileLayout && this.mobileSearchOpen;
    this.elements.searchToggleButton.disabled = this.elements.searchInput.disabled;
    this.elements.searchToggleButton.setAttribute("aria-expanded", String(isOpen));
    this.elements.searchToggleButton.setAttribute("aria-label", isOpen ? "Close search" : "Open search");
    this.elements.searchToggleButton.title = isOpen ? "Close search" : "Search";
  }

  handleGlobalPointerDown(event) {
    if (!(event.target instanceof Node)) {
      return;
    }

    if (
      this.filterMenuOpen &&
      !this.elements.filterAnchor.contains(event.target) &&
      !this.elements.filterMenu.contains(event.target)
    ) {
      this.setFilterMenuOpen(false);
    }

    if (this.isMobileLayout && this.mobileSearchOpen && !this.elements.mapSearchPanel.contains(event.target)) {
      this.setMobileSearchOpen(false);
    }

    if (this.openMenuId) {
      const openMenu = document.getElementById(this.openMenuId);
      // While open, the menu is portaled out of its .tb-item (see
      // portalFloatingMenu), so both the item (the button) and the menu
      // itself have to be checked or clicks inside the menu would close it.
      const openItem = this.openMenuItem || openMenu?.closest(".tb-item");
      const insideItem = Boolean(openItem?.contains(event.target));
      const insideMenu = Boolean(openMenu?.contains(event.target));
      if (!insideItem && !insideMenu) {
        this.closeToolbarMenus();
      }
    }
  }

  // ------------------------------------------------------------------
  // Moderation: hidden players + announcements, served by the viewer's own
  // server and managed by administrators at /setup/. Hidden players are not
  // shown to normal users anywhere in the viewer; administrators bypass.
  // ------------------------------------------------------------------
  /**
   * Mints a fresh game token, at most one call at a time.
   *
   * Every getinfo call rotates the session, so letting several run at once
   * would have them invalidate each other - the classic cause of a burst of
   * 401s. Concurrent callers share one in-flight refresh and all receive the
   * same resulting token.
   */
  recoverSessionToken() {
    // Token login may cycle the token freely: verifying already invalidated
    // the game's in-game session at login, so there is nothing left to
    // protect by refusing to rotate. Keeping the token fresh instead keeps
    // the VIEWER session alive - the whole point.
    if (this.tokenRecoveryPromise) {
      return this.tokenRecoveryPromise;
    }
    const failing = this.session?.token || "";
    this.tokenRecoveryPromise = (async () => {
      try {
        const refreshed = await this.api.refresh(failing);
        this.adoptRefreshedToken(refreshed?.token);
        return this.session?.token || "";
      } catch (error) {
        console.warn("[BYM-MR2] Session recovery failed:", error);
        return "";
      } finally {
        // Cleared on the next tick so callers that failed at nearly the same
        // moment still share this refresh instead of starting another.
        window.setTimeout(() => { this.tokenRecoveryPromise = null; }, 0);
      }
    })();
    return this.tokenRecoveryPromise;
  }

  /**
   * The game session is dead and could not be recovered.
   *
   * Called once, latched by the API client. Everything queued would only
   * produce more 401s, and each 401 would drive another getinfo - the most
   * rate-limited call the viewer makes, and one that rotates the token. So
   * stop fetching, keep the cached map on screen, and say so plainly.
   */
  handleSessionExpired() {
    if (this.sessionExpiredNotified) {
      return;
    }
    this.sessionExpiredNotified = true;
    debugLog("Session expired; halting zone loading until sign-in.");
    try {
      this.renderer?.haltZoneLoading?.();
    } catch (error) {
      console.warn("[BYM-MR2] Could not halt zone loading:", error);
    }
    // Dismissible: the x lets the person drop the notice and keep using
    // the cached map - alliance messages and everything else on the site
    // session keep working; only game-token zone loading stays halted.
    this.renderer?.setOverlay?.(
      "Your game session expired. The map below is the last cached copy - sign in again to keep loading.",
      { dismissible: true },
    );
  }

  adoptRefreshedToken(token) {
    // Verifying our session with the dev server rotates the game token (getinfo
    // mints a new one and invalidates the old). Adopt the returned current token
    // everywhere the old one lived, so subsequent getarea / base requests keep
    // authenticating. Called before renderer.bootstrap(), which reads
    // session.token, so the map loads with the live token.
    const next = String(token || "").trim();
    if (!next || !this.session) {
      return;
    }
    // Any adoption attempt means an authenticated exchange just succeeded,
    // even when the token comes back unchanged (a server-side cache hit) -
    // either way the session was just touched.
    this.lastTokenTouchAt = Date.now();
    if (this.session.token === next) {
      return;
    }
    this.session.token = next;
    // A new token means the session is alive again: re-arm recovery and clear
    // the one-shot expiry notice.
    this.api?.clearAuthExpired?.();
    this.sessionExpiredNotified = false;
    setViewerAuthToken(next);
    try {
      window.localStorage.setItem(buildTokenStorageKey(this.config), next);
    } catch (error) {
      void error;
    }
    if (this.renderer && this.renderer.token) {
      this.renderer.token = next;
    }
  }

  async loadModerationState() {
    try {
      // Do the admin check first and on its own: it verifies our token with the
      // dev server, which rotates it. Adopt the refreshed token before firing
      // the other admin reads, so they present the now-valid token (a cache hit
      // that does NOT rotate again) instead of racing a second rotation.
      const me = await fetchAdminStatus().catch(() => ({ admin: false, user: "", token: "" }));
      this.adoptRefreshedToken(me?.token);

      const [hidden, announcement] = await Promise.all([
        fetchHiddenPlayers().catch(() => ({ names: [], tileStyle: "tribe" })),
        fetchAnnouncement().catch(() => ""),
      ]);

      const isAdmin = Boolean(me?.admin);
      this.isViewerAdmin = isAdmin;
      if (this.renderer) {
        this.renderer.hiddenTileStyle = hidden.tileStyle || "tribe";
      }
      // Pace ourselves to OUR share of the budget: the explicit admin-set
      // client pace when configured, else the per-user ceiling. The server
      // enforces both limits authoritatively regardless.
      const pace = hidden.clientZonePace > 0
        ? hidden.clientZonePace
        : (hidden.maxApiPerMinutePerUser > 0
          ? hidden.maxApiPerMinutePerUser
          : hidden.maxApiPerMinute);
      if (pace > 0) {
        MR2.zoneRequestsPerMinute = pace;
      }
      if (hidden.clientZoneConcurrency > 0) {
        MR2.zoneFetchConcurrency = hidden.clientZoneConcurrency;
      }
      this.rawHiddenPlayerNames = new Set(hidden.names.map((name) => name.toLocaleLowerCase()));
      this.applyHiddenPlayers();
      this.showAnnouncement(announcement);
      // Loot and world-scan controls are admin-only; reveal/hide them now
      // that we know. With every MR2 world fully cached, scanning is a
      // maintenance task rather than something regular players need.
      this.applyLootUi();
      this.applyAdminUi();
    } catch (error) {
      debugLog("Moderation state unavailable", error);
    }
  }

  // Effective hidden set = the moderation list minus the signed-in player
  // themselves and their alliance members: people in the same alliance
  // always see each other's bases and outposts, hidden or not. Re-derived
  // whenever moderation state or alliance membership changes.
  applyHiddenPlayers() {
    if (this.isViewerAdmin) {
      this.hiddenPlayerNames = new Set();
      this.renderer?.setHiddenPlayers([]);
      return;
    }

    const visible = new Set(
      [...this.allianceMemberNames].map((name) => String(name).trim().toLocaleLowerCase()),
    );
    const ownName = String(this.session?.user?.username || "").trim().toLocaleLowerCase();
    if (ownName) {
      visible.add(ownName);
    }

    this.hiddenPlayerNames = new Set(
      [...this.rawHiddenPlayerNames].filter((name) => !visible.has(name)),
    );
    this.renderer?.setHiddenPlayers([...this.hiddenPlayerNames]);
    // An open leaderboard must re-filter immediately (rows render from a
    // cache, so this is cheap and hits no API).
    const lbPanel = document.getElementById("dock-leaderboard-panel");
    if (lbPanel && !lbPanel.hidden) {
      const worldId = String(this.viewedWorldId
        || this.session?.map?.worldid || "").trim();
      if (worldId) this.loadLeaderboard(worldId).catch(() => {});
    }
  }

  isPlayerHidden(name) {
    const normalized = String(name || "").trim().toLocaleLowerCase();
    return Boolean(normalized) && this.hiddenPlayerNames.has(normalized);
  }

  showAnnouncement(text) {
    const banner = document.getElementById("announcement-banner");
    const textEl = document.getElementById("announcement-text-view");
    if (!banner || !textEl) {
      return;
    }

    let dismissed = false;
    try {
      dismissed = window.sessionStorage.getItem("announcementDismissed") === text;
    } catch (error) {
      void error;
    }

    if (!text || dismissed) {
      banner.hidden = true;
      return;
    }

    textEl.textContent = text;
    banner.hidden = false;
    const dismissButton = document.getElementById("announcement-dismiss");
    if (dismissButton && !dismissButton.dataset.bound) {
      dismissButton.dataset.bound = "1";
      dismissButton.addEventListener("click", () => {
        banner.hidden = true;
        try {
          window.sessionStorage.setItem("announcementDismissed", textEl.textContent);
        } catch (error) {
          void error;
        }
      });
    }
  }

  // The cell popup's loot rows are a separate switch from the on-map pills:
  // an admin can want the numbers on the map without them appearing in every
  // cell they open, or the other way round.
  toggleLootInfo(force) {
    this.showLootInfo = typeof force === "boolean" ? force : !this.showLootInfo;
    this.saveUiPref("showLootInfo", this.showLootInfo);
    this.applyLootUi();
  }

  toggleLootDisplay(force) {
    // Tracks the user's intent; the effective on-map display is gated to admins
    // in applyLootUi (loot is admin-only).
    this.showLoot = typeof force === "boolean" ? force : !this.showLoot;
    this.saveUiPref("showLoot", this.showLoot);
    this.applyLootUi();
  }

  setLootResource(key) {
    const valid = ["tier", "total", "r1", "r2", "r3", "r4"];
    this.lootResource = valid.includes(key) ? key : "total";
    this.saveUiPref("lootResource", this.lootResource);
    this.applyLootUi();
  }

  // Reflect the loot controls and push the effective state to the renderer.
  // Loot is administrators-only: non-admins never see the Loot menu and never
  // get loot drawn, regardless of their saved preference.
  applyLootUi() {
    const admin = Boolean(this.isViewerAdmin);
    const adminToolsGroup = null; // admin tools moved into the Settings dock box
    if (adminToolsGroup) {
      // Unhiding the group also draws the "|" separator before Loot.
      adminToolsGroup.hidden = !admin;
    }
    if (this.elements.lootItem) {
      // Loot settings are open to every signed-in viewer now; only Scan
      // and the Admin Console remain admin-gated.
      this.elements.lootItem.hidden = false;
    }
    if (this.elements.setupItem) {
      this.elements.setupItem.hidden = !admin;
    }
    if (!admin && this.openMenuId === "menu-loot") {
      this.closeToolbarMenus();
    }
    if (this.elements.lootShowToggle) {
      this.elements.lootShowToggle.checked = this.showLoot;
    }
    if (this.elements.lootInfoToggle) {
      this.elements.lootInfoToggle.checked = this.showLootInfo;
    }
    for (const radio of document.querySelectorAll("input[name='loot-resource']")) {
      radio.checked = radio.value === this.lootResource;
    }
    this.renderer?.setLootResource(this.lootResource);
    this.renderer?.setShowLoot(this.showLoot);
    // The cell popup's loot rows follow the same toggle, so an open popup has
    // to be redrawn - otherwise turning Loot off left the numbers on screen
    // until the cell was reselected.
    this.renderDetails();
  }

  // ------------------------------------------------------------------
  // Toolbar dropdown menus. One open at a time; buttons carry data-menu
  // pointing at the id of the .tb-menu they control.
  // ------------------------------------------------------------------
  bindToolbarMenus() {
    for (const button of document.querySelectorAll("[data-menu]")) {
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        this.toggleToolbarMenu(button.dataset.menu);
      });
    }
  }

  toggleToolbarMenu(menuId) {
    if (this.openMenuId === menuId) {
      this.closeToolbarMenus();
    } else {
      this.openToolbarMenu(menuId);
      if (menuId === "menu-alliance" && this.allianceActiveTab === "chat") {
        this.clearAllianceUnread();
      }
      if (menuId === "menu-leaderboard") {
        // The leaderboard always shows the world currently on screen (live
        // or guest-cached); loading on open keeps the API budget untouched
        // until someone actually looks, and the per-world cache dedupes.
        const worldId = String(this.viewedWorldId || this.session?.map?.worldid || "").trim();
        if (worldId) {
          this.loadLeaderboard(worldId).catch(() => {});
        } else {
          this.elements.leaderboardTitle.textContent = "No world selected";
          this.elements.leaderboardList.textContent = "View a world to see its leaderboard.";
        }
      }
    }
  }

  openToolbarMenu(menuId) {
    this.closeToolbarMenus();
    const menu = document.getElementById(menuId);
    const item = menu?.closest(".tb-item");
    if (!menu || !item) {
      return;
    }

    this.openMenuId = menuId;
    this.openMenuItem = item;
    item.classList.add("open");
    const button = item.querySelector("[data-menu]") || item.querySelector(".tb-button");
    button?.setAttribute("aria-expanded", "true");
    this.portalFloatingMenu(menu);
    menu.classList.add("open");
    this.positionToolbarDropdown(menu, button);
  }

  // WebKit (iPhone Safari AND iPhone Chrome, which shares the engine)
  // mis-composites position:fixed elements that live inside an overflow
  // scroller: dropdowns inside the scrollable .toolbar-scroll were grouped
  // into the scroller's compositing layer and painted behind the map canvas.
  // While a menu is open it is re-homed to the toolbar element itself -
  // outside .toolbar-scroll but still under .toolbar, so every
  // ".toolbar ..." style rule keeps matching - and put back on close so the
  // DOM matches the markup again. position:fixed placement is
  // viewport-relative either way, so nothing moves.
  portalFloatingMenu(menu) {
    if (!menu || menu.__portalHome) {
      return;
    }
    const toolbar = this.elements.toolbar || document.getElementById("toolbar");
    if (!toolbar || menu.parentNode === toolbar) {
      return;
    }
    menu.__portalHome = { parent: menu.parentNode, next: menu.nextSibling };
    toolbar.appendChild(menu);
  }

  restoreFloatingMenu(menu) {
    const home = menu?.__portalHome;
    if (!home) {
      return;
    }
    menu.__portalHome = null;
    if (home.parent) {
      home.parent.insertBefore(menu, home.next);
    }
  }

  // Re-clamps whatever floating menu is open to the current viewport. Used
  // on height-only resizes (mobile keyboards) where closing would be hostile.
  repositionOpenFloatingMenus() {
    if (this.openMenuId) {
      const menu = document.getElementById(this.openMenuId);
      const item = this.openMenuItem;
      const button = item?.querySelector("[data-menu]") || item?.querySelector(".tb-button");
      this.positionToolbarDropdown(menu, button);
    }
    if (this.filterMenuOpen) {
      this.positionToolbarDropdown(this.elements.filterMenu, this.elements.filterToggleButton);
    }
  }

  // Menus are position:fixed so they can never be clipped by the scrollable
  // toolbar. On desktop we place them under their button (clamped to the
  // viewport); on mobile the stylesheet lays them out as full-width sheets,
  // so any inline placement is cleared instead.
  positionToolbarDropdown(menu, anchor) {
    if (!menu) {
      return;
    }

    if (this.isMobileLayout || !anchor) {
      menu.style.top = "";
      menu.style.left = "";
      menu.style.maxHeight = "";
      menu.style.height = "";
      return;
    }

    const anchorRect = anchor.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth;
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight;

    const top = Math.round(anchorRect.bottom + 8);
    let left = menu.classList.contains("tb-menu-right")
      ? anchorRect.right - menuRect.width
      : anchorRect.left;
    left = Math.round(Math.max(8, Math.min(left, viewportWidth - menuRect.width - 8)));

    menu.style.top = `${top}px`;
    menu.style.left = `${left}px`;
    if (menu.classList.contains("tb-menu-tall")) {
      // Tall menus (leaderboard) always extend flush to the bottom of the
      // screen, regardless of how much content they hold.
      const fullHeight = Math.max(180, viewportHeight - top);
      menu.style.height = `${fullHeight}px`;
      menu.style.maxHeight = `${fullHeight}px`;
    } else {
      menu.style.height = "";
      menu.style.maxHeight = `${Math.max(180, viewportHeight - top - 12)}px`;
    }
  }

  closeToolbarMenus() {
    if (!this.openMenuId) {
      return;
    }
    const menu = document.getElementById(this.openMenuId);
    // The menu is portaled to the toolbar while open, so closest(".tb-item")
    // only works as a fallback; the stored reference is the real owner.
    const item = this.openMenuItem || menu?.closest(".tb-item");
    menu?.classList.remove("open");
    if (menu) {
      this.restoreFloatingMenu(menu);
    }
    item?.classList.remove("open");
    item?.querySelector("[data-menu]")?.setAttribute("aria-expanded", "false");
    this.openMenuId = null;
    this.openMenuItem = null;
  }

  handleGlobalKeyDown(event) {
    if (event.key !== "Escape") {
      return;
    }

    let didHandle = false;
    if (this.openMenuId) {
      this.closeToolbarMenus();
      didHandle = true;
    }

    if (this.filterMenuOpen) {
      this.setFilterMenuOpen(false);
      didHandle = true;
    }

    if (this.isMobileLayout && this.mobileSearchOpen) {
      this.setMobileSearchOpen(false);
      didHandle = true;
    }

    if (didHandle) {
      event.preventDefault();
    }
  }

  handleSearchInput() {
    const query = this.elements.searchInput.value.trim().toLocaleLowerCase();
    if (!query) {
      this.searchMatches = [];
      this.searchActiveIndex = -1;
      this.renderSearchResults();
      return;
    }

    this.searchMatches = this.getRankedSearchMatches(this.searchEntries, query);
    this.searchActiveIndex = this.searchMatches.length ? 0 : -1;
    this.renderSearchResults();
  }

  handleSearchKeyDown(event) {
    if (event.key === "ArrowDown" && this.searchMatches.length) {
      event.preventDefault();
      this.searchActiveIndex = (this.searchActiveIndex + 1) % this.searchMatches.length;
      this.renderSearchResults();
      return;
    }

    if (event.key === "ArrowUp" && this.searchMatches.length) {
      event.preventDefault();
      this.searchActiveIndex =
        (this.searchActiveIndex - 1 + this.searchMatches.length) % this.searchMatches.length;
      this.renderSearchResults();
      return;
    }

    if (event.key === "Escape") {
      if (this.isMobileLayout) {
        this.setMobileSearchOpen(false);
      } else {
        this.hideSearchResults();
      }
      return;
    }

    if (event.key !== "Enter") {
      return;
    }

    event.preventDefault();
    const selectedMatch = this.searchMatches[this.searchActiveIndex] || this.searchMatches[0] || null;
    if (selectedMatch) {
      this.selectSearchResult(selectedMatch);
    }
  }

  renderSearchResults() {
    this.renderSearchResultsDropdown({
      resultsEl: this.elements.searchResults,
      inputEl: this.elements.searchInput,
      matches: this.searchMatches,
      activeIndex: this.searchActiveIndex,
      uiState: this.searchResultsUi.map,
      shouldStayClosed: this.isMobileLayout && this.openMenuId !== "menu-search",
      onHover: (index) => {
        this.searchActiveIndex = index;
        this.syncSearchActiveResult();
      },
      onSelect: (entry) => this.selectSearchResult(entry),
    });
  }

  hideSearchResults() {
    this.setSearchResultsOpen(this.elements.searchResults, false, this.searchResultsUi.map);
  }

  getRankedSearchMatches(entries, query) {
    const normalizedQuery = String(query || "").trim().toLocaleLowerCase();
    if (!normalizedQuery) {
      return [];
    }

    return entries
      .map((entry) => {
        const matchIndex = entry.normalizedUsername.indexOf(normalizedQuery);
        if (matchIndex === -1) {
          return null;
        }

        return {
          ...entry,
          matchIndex,
          isPrefixMatch: matchIndex === 0,
        };
      })
      .filter(Boolean)
      .sort((left, right) => {
        if (left.isPrefixMatch !== right.isPrefixMatch) {
          return left.isPrefixMatch ? -1 : 1;
        }
        if (left.matchIndex !== right.matchIndex) {
          return left.matchIndex - right.matchIndex;
        }
        if (left.distance !== right.distance) {
          return Number(left.distance ?? Number.MAX_SAFE_INTEGER) - Number(right.distance ?? Number.MAX_SAFE_INTEGER);
        }
        return left.normalizedUsername.localeCompare(right.normalizedUsername);
      })
      .slice(0, SEARCH_RESULT_LIMIT);
  }

  renderSearchResultsDropdown({
    resultsEl,
    inputEl,
    matches,
    activeIndex,
    uiState,
    shouldStayClosed,
    onHover,
    onSelect,
  }) {
    const query = inputEl.value.trim();
    const shouldAnimateResize = !resultsEl.hidden && resultsEl.classList.contains("open");
    const previousResultsHeight = shouldAnimateResize ? resultsEl.getBoundingClientRect().height : 0;
    resultsEl.replaceChildren();

    if (!query || !matches.length || inputEl.disabled || shouldStayClosed) {
      this.setSearchResultsOpen(resultsEl, false, uiState);
      return;
    }

    matches.forEach((entry, index) => {
      resultsEl.appendChild(this.buildSearchResultButton({
        entry,
        index,
        activeIndex,
        onHover,
        onSelect,
      }));
    });

    this.setSearchResultsOpen(resultsEl, true, uiState);
    this.syncSearchActiveResult(resultsEl, activeIndex);
    this.animateSearchResultsResize(resultsEl, uiState, previousResultsHeight, shouldAnimateResize);
  }

  buildSearchResultButton({ entry, index, activeIndex, onHover, onSelect }) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "search-result";
    if (index === activeIndex) {
      button.classList.add("active");
    }
    button.innerHTML = `
      <img class="search-result-icon" src="${escapeHtml(this.playerBaseIconUrl)}" alt="">
      <div class="search-result-main">
        <span class="search-result-name">${escapeHtml(entry.username)}</span>
        <span class="search-result-meta">Level ${formatNumber(entry.level)}</span>
      </div>
      <span class="search-result-distance">${escapeHtml(formatDistance(entry.distance))}</span>
    `;
    button.addEventListener("mouseenter", () => onHover(index));
    button.addEventListener("mousedown", (event) => {
      event.preventDefault();
      onSelect(entry);
    });
    return button;
  }

  setSearchResultsOpen(results, isOpen, uiState) {
    const nextIsOpen = Boolean(isOpen);

    if (uiState.closeTimer) {
      window.clearTimeout(uiState.closeTimer);
      uiState.closeTimer = 0;
    }

    this.cancelSearchResultsResizeAnimation(uiState);

    if (nextIsOpen) {
      results.hidden = false;
      results.classList.remove("closing");
      window.requestAnimationFrame(() => {
        if (results.hidden) {
          return;
        }
        results.classList.add("open");
      });
      return;
    }

    results.classList.remove("open");
    if (results.hidden) {
      results.style.height = "";
      results.replaceChildren();
      results.classList.remove("closing");
      return;
    }

    results.classList.add("closing");
    uiState.closeTimer = window.setTimeout(() => {
      results.hidden = true;
      results.style.height = "";
      results.classList.remove("closing");
      results.replaceChildren();
      uiState.closeTimer = 0;
    }, SEARCH_RESULTS_TRANSITION_MS);
  }

  animateSearchResultsResize(results, uiState, previousHeight, shouldAnimate) {
    this.cancelSearchResultsResizeAnimation(uiState);

    if (!shouldAnimate || results.hidden || !results.classList.contains("open")) {
      results.style.height = "";
      return;
    }

    const nextHeight = results.getBoundingClientRect().height;
    if (!previousHeight || Math.abs(nextHeight - previousHeight) < 1) {
      results.style.height = "";
      return;
    }

    results.style.height = `${previousHeight}px`;
    void results.offsetHeight;

    uiState.resizeFrame = window.requestAnimationFrame(() => {
      uiState.resizeFrame = 0;
      results.style.height = `${nextHeight}px`;
      uiState.resizeTimer = window.setTimeout(() => {
        uiState.resizeTimer = 0;
        if (!results.hidden && results.classList.contains("open")) {
          results.style.height = "";
        }
      }, SEARCH_RESULTS_TRANSITION_MS);
    });
  }

  cancelSearchResultsResizeAnimation(uiState) {
    if (uiState.resizeFrame) {
      window.cancelAnimationFrame(uiState.resizeFrame);
      uiState.resizeFrame = 0;
    }

    if (uiState.resizeTimer) {
      window.clearTimeout(uiState.resizeTimer);
      uiState.resizeTimer = 0;
    }
  }

  syncSearchActiveResult(resultsEl = this.elements.searchResults, activeIndex = this.searchActiveIndex) {
    const buttons = resultsEl.querySelectorAll(".search-result");
    buttons.forEach((button, index) => {
      button.classList.toggle("active", index === activeIndex);
    });
  }

  selectSearchResult(entry) {
    this.elements.searchInput.value = entry.username;
    this.hideSearchResults();
    if (this.isMobileLayout) {
      this.setMobileSearchOpen(false);
    }
    this.renderer.focusCell(entry.cell, { animate: true, resetZoom: true });
  }

  setSessionStatus(message, isError = false) {
    message = sanitizeErrorMessage(message);
    this.elements.sessionStatus.hidden = !message;
    this.elements.sessionStatus.textContent = message;
    this.elements.sessionStatus.style.color = isError ? "#ffb59f" : "";
    if (this.session && message) {
      this.showSessionToast(message, isError);
    }
  }

  showSessionToast(message, isError = false) {
    let toast = document.getElementById("session-toast");
    if (!toast) {
      toast = document.createElement("div");
      toast.id = "session-toast";
      toast.className = "session-toast";
      document.body.appendChild(toast);
    }
    toast.textContent = message;
    toast.classList.toggle("error", Boolean(isError));
    toast.classList.add("visible");
    window.clearTimeout(this.sessionToastTimer);
    this.sessionToastTimer = window.setTimeout(() => toast.classList.remove("visible"), 4000);
  }

  setPendingSessionState() {
    this.elements.sessionSignedIn.hidden = true;
    this.elements.accountButton.hidden = false;
    this.elements.loginForm.hidden = false;
    this.elements.sessionPanel.classList.remove("signed-in");
    this.elements.loginButton.disabled = false;
    this.elements.sessionName.textContent = "Loading...";
    this.setSearchEnabled(false, "Loading world map access...");
    this.setFilterEnabled(false);
    this.updateFindHomeButtonState();
    this.selectedCell = null;
    this.hoveredCell = null;
    this.renderer?.reset(INITIAL_OVERLAY_MESSAGE);
    this.renderDetails();
  }

  setSignedOutState({
    sessionStatus = "Sign in with your own BYM credentials.",
    isError = false,
    // A FAILED interactive sign-in must show the error, not silently
    // drop the person into guest view (which is what the logout flow
    // does). reopenSignIn keeps whatever map is on screen, skips the
    // view reset, and brings the account modal back up with the status.
    reopenSignIn = false,
  } = {}) {
    this.elements.sessionSignedIn.hidden = true;
    this.elements.accountButton.hidden = false;
    this.elements.loginForm.hidden = false;
    this.elements.sessionPanel.classList.remove("signed-in");
    this.elements.loginButton.disabled = false;
    this.elements.sessionName.textContent = "Log in";
    this.sessionMapMeta = null;
    this.isViewerAdmin = false;
    this.hiddenPlayerNames = new Set();
    this.rawHiddenPlayerNames = new Set();
    this.applyLootUi();
    this.applyAdminUi();
    setViewerAuthToken("");
    if (this.elements.worldName) {
      this.elements.worldName.textContent = "Not connected";
      this.elements.worldName.title = "";
    }
    this.setSessionStatus(sessionStatus, isError);
    if (reopenSignIn) {
      // Auth failure: keep the current (guest) view and camera; the
      // person just needs to see what went wrong and try again.
      this.stopAlliance();
      this.openAccountModal();
      return;
    }
    this.setSearchEnabled(false, "Sign in to search the loaded world map.");
    this.setFilterEnabled(false);
    this.setMeasureActive(false);
    this.setNavEnabled(false);
    this.updateFindHomeButtonState();
    this.selectedCell = null;
    this.hoveredCell = null;
    this.isGuestView = false;
    this.viewedWorldId = null;
    this.stopAlliance();
    this.closeAllDockPanels?.();
    this.setToolsMinimized?.(true);
    this.hideDockUi?.();
    this.closeModals?.();
    this.stopLeaderboardAutoRefresh();
    this.renderer?.reset(SIGNED_OUT_OVERLAY_MESSAGE);
    this.renderDetails();
    // Logging out returns to the boot choice: the sign-in popup comes up
    // BEFORE any cache loads, so the person picks what to do next -
    // sign back in, or "View as guest" which opens the server picker.
    this.bootChoiceMade = false;
    this.enterGuestViewIfAvailable();
  }

  // ------------------------------------------------------------------
  // Guest view: signed-out visitors can browse the shared cached map
  // read-only. Live fetching, refreshing, and every per-user feature
  // (bookmarks, highlight groups, watch, scan) stay disabled; zones the
  // cache has never seen render grey as "Not Cached".
  // ------------------------------------------------------------------
  async enterGuestViewIfAvailable() {
    if (!this.renderer) {
      return;
    }
    // First load: nothing is fetched from cache until the visitor either
    // signs in or presses "View as guest" (which opens the server
    // picker) - this kills the double cache load that used to happen
    // when someone signed in over an already-loading guest view.
    if (!this.bootChoiceMade) {
      // A share link naming a world is its own boot choice: someone
      // following copied coordinates wants the map, not a sign-in prompt.
      // Fall through into the guest path, which already resolves the linked
      // world and jumps to the cell; Account stays one click away.
      if (this.pendingUrlJump?.world) {
        this.bootChoiceMade = true;
      } else {
        this.openAccountModal();
        return;
      }
    }
    const attempt = ++this.guestAttemptId;
    // Committed to guest browsing now: swap the signed-out overlay for a
    // neutral loading message before any async work, so the window never
    // shows "Please log in." to someone who chose (or deep-linked into)
    // the guest view.
    this.renderer.setOverlay("Loading cached map...");

    let servers = [];
    try {
      servers = await storageListServers();
    } catch (error) {
      debugLog("Guest view unavailable (server list failed).", error);
      return;
    }
    if (attempt !== this.guestAttemptId || this.session) {
      return; // a sign-in (or newer signed-out reset) superseded this attempt
    }
    if (!servers.length) {
      this.renderer.setOverlay("No cached map data available yet. Sign in to load the live map.");
      return;
    }
    this.cachedServers = new Map(servers.map((entry) => [entry.name, entry]));

    // Most recently updated world wins by default; a share link naming a
    // cached world overrides that, and the worlds picker lets the visitor
    // switch afterwards either way.
    let world = servers[0];
    const linkedWorld = this.pendingUrlJump?.world;
    if (linkedWorld) {
      const match = servers.find((entry) => entry.name === linkedWorld);
      if (match) {
        world = match;
      }
    }
    const label = this.worldNameById?.get(world.name) || "";
    debugLog(`Guest view: loading cached world ${world.name} (${world.zones} zones).`);
    await this.enterGuestWorldView(world.name, label);
  }

  // Shared cached-world view. Works signed out (a plain guest) and signed
  // in (browsing a world that is not the session's own); either way the
  // map is read-only and every session-only control stays greyed out.
  async enterGuestWorldView(serverName, worldLabel = "") {
    if (!this.renderer) {
      return;
    }
    const attempt = ++this.guestAttemptId;
    const hadSession = Boolean(this.session);
    // Measurements belong to the world they were made on.
    this.setMeasureActive(false);

    const restoredZones = await this.renderer.bootstrapGuest(serverName);
    if (attempt !== this.guestAttemptId || Boolean(this.session) !== hadSession) {
      return; // superseded by a sign-in/out or another view switch
    }

    this.isGuestView = true;
    this.viewedWorldId = String(serverName);
    this.selectedCell = null;
    this.hoveredCell = null;

    const label = worldLabel || this.worldNameById?.get(String(serverName)) || "";
    if (this.elements.worldName) {
      // The strip's "cached" prefix marks the state; no "(cached)" suffix.
      this.elements.worldName.textContent = label || "Guest view";
      const cachedPrefix = document.getElementById("world-cached-prefix");
      if (cachedPrefix) cachedPrefix.hidden = false;
      this.elements.worldName.title = `World ${serverName} - showing cached map data only.`;
    }
    this.setSessionStatus(
      hadSession
        ? `Viewing ${label || "another world"} from its cache. Pick your own world to return to live data.`
        : "Viewing the cached map as a guest. Sign in for live data.",
    );

    // Baseline: everything session-only greyed out, then re-enable the
    // read-only controls that work on cached data.
    this.setNavEnabled(false);
    this.rebuildSearchIndex();
    this.rebuildFilterOptions(false);
    this.setSearchEnabled(
      true,
      this.searchEntries.length
        ? `${formatNumber(this.searchEntries.length)} player bases indexed from cached zones.`
        : "No player bases in the cached zones yet.",
    );
    this.setFilterEnabled(true);
    this.setGuestControlsEnabled();
    // Guests get the same UI preferences (and their defaults - outpost
    // types and loot pills are ON out of the box) as signed-in viewers.
    // Without this the renderer kept its constructor flags, so the
    // default-on overlays never appeared in guest view.
    this.applyUiPrefsToUi();
    this.updateFindHomeButtonState();
    this.renderWorldList();
    this.renderDetails();
    if (
      this.pendingUrlJump &&
      (!this.pendingUrlJump.world || this.pendingUrlJump.world === String(serverName))
    ) {
      const target = this.pendingUrlJump;
      this.pendingUrlJump = null;
      this.renderer.jumpToCoordinates(target.x, target.y);
      debugLog("Jumped to URL target (guest view)", target);
    }
    debugLog(`Guest world view ready: ${serverName}, ${restoredZones} cached zones restored.`);
  }

  // Re-enables only the controls that work on cached data. Everything that
  // needs a session - bookmarks, highlight groups, watch, scan, refresh,
  // find-home - stays greyed out from the setNavEnabled(false) baseline.
  setGuestControlsEnabled() {
    this.elements.jumpXInput.disabled = false;
    this.elements.jumpYInput.disabled = false;
    this.elements.jumpButton.disabled = false;
    this.elements.measureButton.disabled = false;

    const maxX = (this.renderer?.getMapWidth() || 800) - 1;
    const maxY = (this.renderer?.getMapHeight() || 800) - 1;
    this.elements.jumpXInput.max = String(maxX);
    this.elements.jumpYInput.max = String(maxY);
    if (this.elements.jumpStatus) this.elements.jumpStatus.textContent = `Jump to any cell (0-${maxX}, 0-${maxY}); coordinates wrap around the map edges.`;
    const bookmarkHelp = document.getElementById("bookmark-help");
    if (bookmarkHelp) {
      /* bookmark help label removed with the dropdown */
    }
    this.elements.scanStatus.textContent = "Sign in to scan the world.";
  }

  // ------------------------------------------------------------------
  // Alliances: one per player, invite-and-accept membership, member chat.
  // Membership feeds the ally highlights and watch tracking automatically.
  // ------------------------------------------------------------------
  startAlliance() {
    if (!this.session || !this.elements.allianceItem) {
      return;
    }
    this.elements.allianceItem.hidden = false;
    this.refreshAllianceState();
    this.stopAlliancePolling();
    this.alliancePollTick = 0;
    this.alliancePollTimer = window.setInterval(() => this.pollAllianceTick(), 5000);
  }

  stopAlliance() {
    this.stopAlliancePolling();
    this.alliance = null;
    this.allianceInvites = [];
    this.allianceMemberNames = new Set();
    this.allianceEnemyNames = new Set();
    this.allianceChat = [];
    this.allianceChatLatest = 0;
    this.alliancePanelSignature = null;
    this.allianceUnreadChat = 0;
    this.updateAllianceBadge();
    this.applyHiddenPlayers();
    // Ex-allies keep no map colours: push the now-empty sets down.
    this.applyHighlightsToRenderer();
    if (this.elements.allianceItem) {
      this.elements.allianceItem.hidden = true;
    }
  }

  stopAlliancePolling() {
    if (this.alliancePollTimer) {
      window.clearInterval(this.alliancePollTimer);
      this.alliancePollTimer = 0;
    }
  }

  pollAllianceTick() {
    if (!this.session) {
      this.stopAlliance();
      return;
    }
    this.alliancePollTick += 1;
    if (this.alliance) {
      // Chat every 5s; full membership/invite refresh every 30s.
      if (this.alliancePollTick % 6 === 0) {
        this.refreshAllianceState();
      } else {
        this.fetchAllianceChat();
      }
    } else if (this.alliancePollTick % 3 === 0) {
      // Not in an alliance: look for new invites every 15s.
      this.refreshAllianceState();
    }
  }

  async refreshAllianceState() {
    if (!this.session) {
      return;
    }
    try {
      const payload = await allianceMe();
      this.adoptRefreshedToken(payload?.token);
      const previousSignature =
        [...this.allianceMemberNames].sort().join(",") + "|" + [...this.allianceEnemyNames].sort().join(",");
      this.alliance = payload?.alliance || null;
      this.allianceInvites = Array.isArray(payload?.invites) ? payload.invites : [];
      this.allianceMemberNames = new Set(
        (this.alliance?.members || []).map((m) => String(m?.name || "").trim()).filter(Boolean),
      );
      this.allianceEnemyNames = new Set([
        ...(this.alliance?.enemies || []).map((e) => String(e?.name || "").trim()),
        ...(this.alliance?.enemyAlliances || []).flatMap((group) =>
          (group?.members || []).map((m) => String(m?.name || "").trim())),
      ].filter(Boolean));
      this.allianceMemberMeta = new Map(
        (this.alliance?.members || []).map((m) => [String(m?.name || "").trim().toLocaleLowerCase(), m]),
      );
      this.allianceEnemyLower = new Set(
        [...this.allianceEnemyNames].map((n) => n.toLocaleLowerCase()),
      );
      if (!this.alliance) {
        this.allianceChat = [];
        this.allianceChatLatest = 0;
      }
      const signature =
        [...this.allianceMemberNames].sort().join(",") + "|" + [...this.allianceEnemyNames].sort().join(",");
      if (signature !== previousSignature) {
        this.applyHighlightsToRenderer();
        this.applyHiddenPlayers();
      }
      // Re-render only when the rendered state changed: rebuilding the panel
      // on every poll would wipe text mid-typed into the chat/invite/create
      // inputs and steal focus. (Chat messages render into their own log.)
      const panelSignature = JSON.stringify({
        alliance: this.alliance ? { ...this.alliance, feed: undefined } : null,
        invites: this.allianceInvites,
      });
      if (panelSignature !== this.alliancePanelSignature) {
        this.alliancePanelSignature = panelSignature;
        this.renderAlliancePanel();
      }
      this.renderAllianceFeed();
      this.updateAllianceBadge();
      if (this.alliance) {
        this.fetchAllianceChat();
      }
    } catch (error) {
      debugLog("Alliance state unavailable.", error);
    }
  }

  async fetchAllianceChat() {
    if (!this.session || !this.alliance) {
      return;
    }
    try {
      const payload = await allianceChatFetch(this.allianceChatLatest);
      this.adoptRefreshedToken(payload?.token);
      const fresh = (Array.isArray(payload?.messages) ? payload.messages : [])
        .filter((m) => m && Number(m.at) > this.allianceChatLatest);
      if (!fresh.length) {
        return;
      }
      this.allianceChat = [...this.allianceChat, ...fresh].slice(-200);
      this.allianceChatLatest = Math.max(
        this.allianceChatLatest,
        ...fresh.map((m) => Number(m.at) || 0),
      );
      this.renderAllianceChatLog();
      const chatInView = this.openMenuId === "menu-alliance" && this.allianceActiveTab === "chat";
      if (chatInView) {
        // Reading live: keep the persisted watermark moving too.
        this.clearAllianceUnread();
      } else {
        const readAt = Number(this.userSettings?.allianceChatReadAt || 0);
        const unseen = fresh.filter((m) => Number(m.at) > readAt).length;
        if (unseen > 0) {
          this.allianceUnreadChat += unseen;
          this.allianceTabButtons?.chat?.classList.add("unread");
          this.updateAllianceBadge();
        }
      }
    } catch (error) {
      debugLog("Alliance chat fetch failed.", error);
    }
  }

  async allianceAction(endpoint, body, statusEl) {
    try {
      const payload = await alliancePost(endpoint, body);
      this.adoptRefreshedToken(payload?.token);
      await this.refreshAllianceState();
      return true;
    } catch (error) {
      if (statusEl) {
        statusEl.textContent = error?.message || "Alliance action failed.";
      }
      return false;
    }
  }

  renderAlliancePanel() {
    const container = this.elements.allianceContent;
    if (!container) {
      return;
    }
    container.replaceChildren();
    if (!this.session) {
      container.innerHTML = '<p class="muted">Sign in to use alliances.</p>';
      return;
    }

    const status = document.createElement("p");
    status.className = "muted alliance-status";

    if (!this.alliance) {
      if (this.allianceInvites.length) {
        const heading = document.createElement("p");
        heading.className = "eyebrow";
        heading.textContent = "Invites";
        container.appendChild(heading);
        for (const name of this.allianceInvites) {
          const row = document.createElement("div");
          row.className = "alliance-invite-row";
          const label = document.createElement("span");
          label.textContent = name;
          const accept = document.createElement("button");
          accept.type = "button";
          accept.className = "secondary-button";
          accept.textContent = "Accept";
          accept.addEventListener("click", () =>
            this.allianceAction("respond", { alliance: name, action: "accept" }, status));
          const decline = document.createElement("button");
          decline.type = "button";
          decline.className = "secondary-button danger";
          decline.textContent = "Decline";
          decline.addEventListener("click", () =>
            this.allianceAction("respond", { alliance: name, action: "decline" }, status));
          row.append(label, accept, decline);
          container.appendChild(row);
        }
      }

      const createLabel = document.createElement("p");
      createLabel.className = "eyebrow";
      createLabel.textContent = "Create an alliance";
      const createRow = document.createElement("div");
      createRow.className = "alliance-form-row";
      const nameInput = document.createElement("input");
      nameInput.type = "text";
      nameInput.maxLength = 40;
      nameInput.placeholder = "Alliance name";
      const createButton = document.createElement("button");
      createButton.type = "button";
      createButton.className = "secondary-button";
      createButton.textContent = "Create";
      const submit = () => {
        const name = nameInput.value.trim();
        if (name) {
          this.allianceAction("create", { name }, status);
        }
      };
      createButton.addEventListener("click", submit);
      nameInput.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          submit();
        }
      });
      createRow.append(nameInput, createButton);
      container.append(createLabel, createRow, status);
      return;
    }

    // ---- Header: name, member count, leave ----
    const header = document.createElement("div");
    header.className = "alliance-header";
    const headText = document.createElement("div");
    const title = document.createElement("p");
    title.className = "alliance-title";
    title.textContent = this.alliance.name;
    const memberCount = document.createElement("p");
    memberCount.className = "muted alliance-member-count";
    const count = (this.alliance.members || []).length;
    memberCount.textContent = `${count} member${count === 1 ? "" : "s"}`;
    headText.append(title, memberCount);
    const leave = document.createElement("button");
    leave.type = "button";
    leave.className = "game-button alliance-game-btn alliance-leave";
    leave.textContent = "Leave";
    leave.title = `Leave ${this.alliance.name}`;
    leave.addEventListener("click", () => {
      if (window.confirm(`Leave ${this.alliance.name}?`)) {
        this.allianceAction("leave", null, status);
      }
    });
    header.append(headText, leave);
    container.appendChild(header);

    // ---- Tabs: Chat (default) | Members | Enemies ----
    const ownName = String(this.session?.user?.username || "").trim().toLocaleLowerCase();
    const isLeader = String(this.alliance.leader || "").trim().toLocaleLowerCase() === ownName;

    const tabBar = document.createElement("div");
    tabBar.className = "alliance-tabs";
    const sections = {};
    this.allianceTabButtons = {};
    for (const [key, label] of [["chat", "Chat"], ["members", "Members"], ["enemies", "Enemies"], ["targets", "Targets"], ["feed", "Feed"]]) {
      const tab = document.createElement("button");
      tab.type = "button";
      tab.className = "alliance-tab";
      tab.textContent = label;
      tab.addEventListener("click", () => this.setAllianceTab(key));
      this.allianceTabButtons[key] = tab;
      tabBar.appendChild(tab);
      sections[key] = document.createElement("div");
      sections[key].className = "alliance-section";
    }
    container.appendChild(tabBar);
    this.allianceSections = sections;

    // ---- Chat ----
    const chatLog = document.createElement("div");
    chatLog.className = "alliance-chat-log";
    chatLog.id = "alliance-chat-log";
    const chatRow = document.createElement("div");
    chatRow.className = "alliance-form-row";
    const chatInput = document.createElement("input");
    chatInput.type = "text";
    chatInput.maxLength = 300;
    chatInput.placeholder = "Message your alliance";
    const chatSend = document.createElement("button");
    chatSend.type = "button";
    chatSend.className = "secondary-button";
    chatSend.textContent = "Send";
    const submitChat = async () => {
      const text = chatInput.value.trim();
      if (!text) {
        return;
      }
      chatInput.value = "";
      const ok = await this.allianceAction("chat", { text }, status);
      if (ok) {
        this.fetchAllianceChat();
      }
      chatInput.focus();
    };
    chatSend.addEventListener("click", submitChat);
    chatInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        submitChat();
      }
    });
    chatRow.append(chatInput, chatSend);
    sections.chat.append(chatLog, chatRow);

    // ---- Members ----
    const RANK_VALUE = { recruit: 0, member: 1, officer: 2, leader: 3 };
    const myRank = String(this.alliance.yourRank || "member");
    const myRankValue = RANK_VALUE[myRank] ?? 1;
    const canInvite = myRankValue >= RANK_VALUE.member;
    const canEditEnemies = myRankValue >= RANK_VALUE.officer;

    const memberList = document.createElement("div");
    memberList.className = "alliance-members";
    for (const member of this.alliance.members || []) {
      const rank = String(member.rank || "member");
      const targetValue = RANK_VALUE[rank] ?? 1;
      const isSelf = String(member.name).trim().toLocaleLowerCase() === ownName;

      // Two-line member card:
      //   [Role] Name   seen ...          [Jump]
      //   X Outposts on Y Server          [rank/kick controls]
      const row = document.createElement("div");
      row.className = "alliance-roster-row alliance-member-grid";

      const line1 = document.createElement("div");
      line1.className = "amg-line amg-l1";
      if (rank) {
        const pill = document.createElement("span");
        pill.className = `alliance-rank-pill rank-${rank}`;
        pill.textContent = rank.charAt(0).toUpperCase() + rank.slice(1);
        line1.appendChild(pill);
      }
      const nameEl = document.createElement("span");
      const memberRel = this.nameRelationClass(member.name);
      nameEl.className = "alliance-identity-name" + (memberRel ? " " + memberRel : "");
      nameEl.textContent = member.name;
      nameEl.title = member.name;
      line1.appendChild(nameEl);
      if (Number(member.seenAt || 0) > 0) {
        const seen = document.createElement("span");
        seen.className = "alliance-identity-meta";
        seen.textContent = `seen ${formatRelativeTime(Number(member.seenAt))}`;
        seen.title = "When any cached zone last contained this player's cells";
        line1.appendChild(seen);
      }
      row.appendChild(line1);

      const jumpSlot = document.createElement("div");
      jumpSlot.className = "amg-slot amg-r1";
      if (member.main) {
        jumpSlot.appendChild(this.buildAllianceButton("Jump", `Jump to ${member.name}'s main yard`,
          () => this.jumpToAllianceYard(member)));
      }
      row.appendChild(jumpSlot);

      const line2 = document.createElement("div");
      line2.className = "amg-line amg-l2 alliance-identity-meta";
      const opCount = Number(member.outposts || 0);
      const worldName = this.allianceWorldName(member.world) || "";
      const worldLabel = worldName
        ? (/server$/i.test(worldName) ? worldName : `${worldName} Server`)
        : "unknown server";
      line2.textContent =
        `${formatNumber(opCount)} Outpost${opCount === 1 ? "" : "s"} on ${worldLabel}`;
      row.appendChild(line2);

      const actions = document.createElement("div");
      actions.className = "alliance-row-actions amg-slot amg-r2";
      // NOTE: this rank matrix is intentionally duplicated on the server
      // (dev_server.py, handle_alliance -> kick/promote/demote), which is
      // the actual authority; these buttons only decide what is shown.
      // Change both together.
      // Rank controls. Leaders keep full power over everyone below;
      // officers manage members and recruits (promote up to officer,
      // demote member->recruit) plus their own step-down; members and up
      // may invite (gated elsewhere) and kick per the kick rule below.
      const canPromote = !isSelf && (
        (myRank === "leader" && rank !== "leader")
        || (myRank === "officer" && (rank === "recruit" || rank === "member"))
      );
      const canDemote = !isSelf && (
        (myRank === "leader" && rank !== "recruit" && rank !== "leader")
        || (myRank === "officer" && rank === "member")
      );
      if (canPromote) {
        actions.appendChild(this.buildAllianceButton("\u25b2",
          (myRank === "leader" && rank === "officer")
            ? `Promote ${member.name} to leader (transfers leadership)`
            : `Promote ${member.name}`,
          () => this.allianceAction("promote", { name: member.name }, status)));
      }
      if (canDemote) {
        actions.appendChild(this.buildAllianceButton("\u25bc", `Demote ${member.name}`,
          () => this.allianceAction("demote", { name: member.name }, status)));
      }
      if (isSelf && myRank === "officer") {
        // Officers may step down on their own.
        actions.appendChild(this.buildAllianceButton("\u25bc", "Step down to Member", () => {
          if (window.confirm("Step down from Officer to Member?")) {
            this.allianceAction("demote", { name: member.name }, status);
          }
        }));
      }
      // Kick rule: leader -> anyone below; officer -> members and
      // recruits; member -> recruits.
      const canKick = !isSelf && (
        (myRank === "leader" && targetValue < RANK_VALUE.leader)
        || (myRank === "officer" && targetValue <= RANK_VALUE.member)
        || (myRank === "member" && targetValue === RANK_VALUE.recruit)
      );
      if (canKick) {
        const kick = this.buildAllianceButton("\u2715", `Remove ${member.name} from ${this.alliance.name}`, () => {
          if (window.confirm(`Remove ${member.name} from ${this.alliance.name}?`)) {
            this.allianceAction("kick", { name: member.name }, status);
          }
        });
        kick.classList.add("danger");
        actions.appendChild(kick);
      }
      row.appendChild(actions);
      memberList.appendChild(row);
    }
    sections.members.appendChild(memberList);

    if (canInvite) {
      // Sits directly under the last member row; the input suggests
      // player names from the map's search index as you type.
      const inviteRow = document.createElement("div");
      inviteRow.className = "alliance-form-row alliance-invite-row";
      const inviteWrap = document.createElement("div");
      inviteWrap.className = "alliance-invite-wrap";
      const inviteInput = document.createElement("input");
      inviteInput.type = "text";
      inviteInput.maxLength = 80;
      inviteInput.placeholder = "Invite a player by username";
      inviteInput.autocomplete = "off";
      const inviteResults = document.createElement("div");
      inviteResults.className = "filter-player-results alliance-invite-results";
      inviteResults.hidden = true;
      inviteWrap.append(inviteInput, inviteResults);
      const memberLows = new Set(
        (this.alliance.members || []).map((m) => String(m.name || "").trim().toLocaleLowerCase()));
      const pendingLows = new Set(
        (this.alliance.invites || []).map((n) => String(n).trim().toLocaleLowerCase()));
      const refreshSuggestions = () => {
        const query = inviteInput.value.trim().toLocaleLowerCase();
        inviteResults.textContent = "";
        if (query.length < 2) {
          inviteResults.hidden = true;
          return;
        }
        const matches = [];
        for (const entry of this.searchEntries || []) {
          const low = entry.normalizedUsername || "";
          if (!low.includes(query) || memberLows.has(low) || pendingLows.has(low)) continue;
          matches.push(entry);
          if (matches.length >= 8) break;
        }
        if (!matches.length) {
          inviteResults.hidden = true;
          return;
        }
        for (const entry of matches) {
          const option = document.createElement("button");
          option.type = "button";
          option.className = "search-result";
          option.textContent = entry.username;
          option.addEventListener("mousedown", (event) => {
            event.preventDefault();
            inviteInput.value = entry.username;
            inviteResults.hidden = true;
            inviteInput.focus();
          });
          inviteResults.appendChild(option);
        }
        inviteResults.hidden = false;
      };
      inviteInput.addEventListener("input", refreshSuggestions);
      inviteInput.addEventListener("focus", refreshSuggestions);
      inviteInput.addEventListener("blur", () => {
        window.setTimeout(() => { inviteResults.hidden = true; }, 120);
      });
      inviteInput.addEventListener("keydown", (event) => {
        if (event.key === "Escape") inviteResults.hidden = true;
      });
      const inviteButton = document.createElement("button");
      inviteButton.type = "button";
      inviteButton.className = "game-button alliance-game-btn";
      inviteButton.textContent = "Invite";
      const submitInvite = () => {
        const name = inviteInput.value.trim();
        if (name) {
          inviteInput.value = "";
          this.allianceAction("invite", { name }, status);
        }
      };
      inviteButton.addEventListener("click", submitInvite);
      inviteInput.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          submitInvite();
        }
      });
      inviteRow.append(inviteWrap, inviteButton);
      sections.members.appendChild(inviteRow);
    } else {
      const hint = document.createElement("p");
      hint.className = "muted alliance-hint";
      hint.textContent = "Recruits cannot invite players.";
      sections.members.appendChild(hint);
    }

    if ((this.alliance.invites || []).length) {
      const pendingHeading = document.createElement("p");
      pendingHeading.className = "muted alliance-pending";
      pendingHeading.textContent = "Pending invites:";
      sections.members.appendChild(pendingHeading);
      for (const invited of this.alliance.invites) {
        const row = document.createElement("div");
        row.className = "alliance-member-row";
        const label = document.createElement("span");
        label.textContent = invited;
        row.appendChild(label);
        if (myRankValue >= RANK_VALUE.member) {
          const revoke = this.buildAllianceButton("\u2715", `Revoke ${invited}'s invite`,
            () => this.allianceAction("uninvite", { name: invited }, status));
          revoke.classList.add("danger");
          row.appendChild(revoke);
        }
        sections.members.appendChild(row);
      }
    }

    // ---- Enemies ----
    const enemyHint = document.createElement("p");
    enemyHint.className = "muted alliance-hint";
    enemyHint.textContent =
      "Enemies render red on every member's map. Marking a player who belongs to an alliance marks their whole alliance - current and future members.";
    sections.enemies.appendChild(enemyHint);

    const enemyList = document.createElement("div");
    enemyList.className = "alliance-members alliance-enemies";
    const enemies = this.alliance.enemies || [];
    if (!enemies.length) {
      enemyList.innerHTML = '<span class="muted">No enemies marked yet.</span>';
    }
    for (const enemy of enemies) {
      const row = document.createElement("div");
      row.className = "alliance-roster-row";
      row.appendChild(this.buildAllianceIdentity(enemy, null, { enemy: true }));
      const actions = document.createElement("div");
      actions.className = "alliance-row-actions";
      if (enemy.main) {
        actions.appendChild(this.buildAllianceButton("Jump", `Jump to ${enemy.name}'s main yard`,
          () => this.jumpToAllianceYard(enemy)));
      }
      if (canEditEnemies) {
        const remove = this.buildAllianceButton("\u2715", `Remove ${enemy.name} from the enemy list`,
          () => this.allianceAction("enemies", { action: "remove", name: enemy.name }, status));
        remove.classList.add("danger");
        actions.appendChild(remove);
      }
      row.appendChild(actions);
      enemyList.appendChild(row);
    }
    sections.enemies.appendChild(enemyList);

    for (const group of this.alliance.enemyAlliances || []) {
      const groupHeader = document.createElement("div");
      groupHeader.className = "alliance-enemy-group-header";
      const groupTitle = document.createElement("span");
      const memberCount = (group.members || []).length;
      groupTitle.className = "alliance-enemy-group-title";
      groupTitle.textContent = group.exists === false
        ? `${group.name} (disbanded)`
        : `${group.name} - ${memberCount} member${memberCount === 1 ? "" : "s"}`;
      groupHeader.appendChild(groupTitle);
      if (canEditEnemies) {
        const removeGroup = this.buildAllianceButton("\u2715",
          `Remove the whole ${group.name} alliance from the enemy list`,
          () => this.allianceAction("enemies", { action: "remove_alliance", name: group.name }, status));
        removeGroup.classList.add("danger");
        groupHeader.appendChild(removeGroup);
      }
      sections.enemies.appendChild(groupHeader);

      const groupList = document.createElement("div");
      groupList.className = "alliance-members alliance-enemies";
      for (const member of group.members || []) {
        const row = document.createElement("div");
        row.className = "alliance-roster-row";
        row.appendChild(this.buildAllianceIdentity(member, null, { enemy: true }));
        const actions = document.createElement("div");
        actions.className = "alliance-row-actions";
        if (member.main) {
          actions.appendChild(this.buildAllianceButton("Jump", `Jump to ${member.name}'s main yard`,
            () => this.jumpToAllianceYard(member)));
        }
        row.appendChild(actions);
        groupList.appendChild(row);
      }
      sections.enemies.appendChild(groupList);
    }

    if (canEditEnemies) {
      const enemyRow = document.createElement("div");
      enemyRow.className = "alliance-form-row";
      const enemyWrap = document.createElement("div");
      enemyWrap.className = "alliance-invite-wrap";
      const enemyInput = document.createElement("input");
      enemyInput.type = "text";
      enemyInput.maxLength = 80;
      enemyInput.placeholder = "Mark a player as an enemy";
      enemyInput.autocomplete = "off";
      const enemyResults = document.createElement("div");
      enemyResults.className = "filter-player-results alliance-invite-results";
      enemyResults.hidden = true;
      enemyWrap.append(enemyInput, enemyResults);
      const enemyLows = new Set((this.alliance.enemies || [])
        .map((e) => String(e.name || "").trim().toLocaleLowerCase()));
      const ownLows = new Set((this.alliance.members || [])
        .map((m) => String(m.name || "").trim().toLocaleLowerCase()));
      const refreshEnemySuggestions = () => {
        const query = enemyInput.value.trim().toLocaleLowerCase();
        enemyResults.textContent = "";
        if (query.length < 2) { enemyResults.hidden = true; return; }
        const matches = [];
        for (const entry of this.searchEntries || []) {
          const low = entry.normalizedUsername || "";
          if (!low.includes(query) || enemyLows.has(low) || ownLows.has(low)) continue;
          matches.push(entry);
          if (matches.length >= 8) break;
        }
        if (!matches.length) { enemyResults.hidden = true; return; }
        for (const entry of matches) {
          const option = document.createElement("button");
          option.type = "button";
          option.className = "search-result";
          option.textContent = entry.username;
          option.addEventListener("mousedown", (event) => {
            event.preventDefault();
            enemyInput.value = entry.username;
            enemyResults.hidden = true;
            enemyInput.focus();
          });
          enemyResults.appendChild(option);
        }
        enemyResults.hidden = false;
      };
      enemyInput.addEventListener("input", refreshEnemySuggestions);
      enemyInput.addEventListener("focus", refreshEnemySuggestions);
      enemyInput.addEventListener("blur", () => {
        window.setTimeout(() => { enemyResults.hidden = true; }, 120);
      });
      enemyInput.addEventListener("keydown", (event) => {
        if (event.key === "Escape") enemyResults.hidden = true;
      });
      const enemyButton = document.createElement("button");
      enemyButton.type = "button";
      enemyButton.className = "game-button alliance-game-btn danger";
      enemyButton.textContent = "Add";
      const submitEnemy = () => {
        const name = enemyInput.value.trim();
        if (name) {
          enemyInput.value = "";
          this.allianceAction("enemies", { action: "add", name }, status);
        }
      };
      enemyButton.addEventListener("click", submitEnemy);
      enemyInput.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          submitEnemy();
        }
      });
      enemyRow.append(enemyWrap, enemyButton);
      sections.enemies.appendChild(enemyRow);
    } else {
      const hint = document.createElement("p");
      hint.className = "muted alliance-hint";
      hint.textContent = "Officers and the leader manage the enemy list.";
      sections.enemies.appendChild(hint);
    }

    // ---- Targets: shared coordinates with notes ----
    const canAddTargets = myRankValue >= RANK_VALUE.officer;
    const targetHint = document.createElement("p");
    targetHint.className = "muted alliance-hint";
    targetHint.textContent = "Shared attack coordinates for the whole alliance. Officers and the leader manage the list.";
    sections.targets.appendChild(targetHint);

    const targets = this.alliance.targets || [];
    // War-night rotation: one button cycles through the shared targets
    // in display order, with a toast naming where you landed.
    if (targets.length > 1) {
      const cycleRow = document.createElement("div");
      cycleRow.className = "alliance-form-row";
      const cycleButton = this.buildAllianceButton("Jump: Next Target",
        "Cycle through the shared targets in order", () => {
          const ordered = [...targets].reverse();
          this.targetCycleIndex = ((this.targetCycleIndex ?? -1) + 1) % ordered.length;
          const target = ordered[this.targetCycleIndex];
          this.jumpToAllianceYard({ world: target.world, main: { x: target.x, y: target.y } });
          const note = String(target.note || "").trim();
          this.showGameToast(`Target ${this.targetCycleIndex + 1} of ${ordered.length}${note ? `: ${note.slice(0, 60)}` : ""}`);
        });
      cycleRow.appendChild(cycleButton);
      sections.targets.appendChild(cycleRow);
    }
    const targetList = document.createElement("div");
    targetList.className = "alliance-members alliance-targets";
    if (!targets.length) {
      targetList.innerHTML = '<span class="muted">No targets marked yet. Select a cell on the map, then add it here.</span>';
    }
    for (const target of [...targets].reverse()) {
      // Two lines: the note owns the full row width; below it the Jump
      // button with the coordinates + server to its right, remove at the
      // far end.
      const row = document.createElement("div");
      row.className = "alliance-roster-row alliance-target-row";
      const note = document.createElement("div");
      note.className = "alliance-target-note";
      note.textContent = target.note || "(no note)";
      note.title = `Added by ${target.addedBy || "?"}`;
      row.appendChild(note);
      const actions = document.createElement("div");
      actions.className = "alliance-row-actions alliance-target-actions";
      actions.appendChild(this.buildAllianceButton("Jump", `Jump to ${target.x}, ${target.y}`,
        () => this.jumpToAllianceYard({ world: target.world, main: { x: target.x, y: target.y } })));
      const where = document.createElement("span");
      where.className = "alliance-target-where";
      const worldName = this.allianceWorldName(target.world) || "\u2014";
      where.textContent = `${target.x}, ${target.y} on ${worldName}`;
      actions.appendChild(where);
      if (myRankValue >= RANK_VALUE.officer) {
        const remove = this.buildAllianceButton("\u2715", "Remove this target",
          () => this.allianceAction("targets", { action: "remove", x: target.x, y: target.y, world: target.world }, status));
        remove.classList.add("danger");
        actions.appendChild(remove);
      }
      row.appendChild(actions);
      targetList.appendChild(row);
    }
    sections.targets.appendChild(targetList);

    if (canAddTargets) {
      const targetRow = document.createElement("div");
      targetRow.className = "alliance-form-row";
      const noteInput = document.createElement("input");
      noteInput.type = "text";
      noteInput.maxLength = 120;
      noteInput.placeholder = "Note (e.g. hit after 8pm)";
      const addButton = document.createElement("button");
      addButton.type = "button";
      addButton.className = "secondary-button";
      addButton.textContent = "Add Selected Cell";
      addButton.title = "Adds the cell currently selected on the map";
      addButton.addEventListener("click", () => {
        const cell = this.selectedCell;
        if (!cell) {
          status.textContent = "Select a cell on the map first.";
          return;
        }
        const note = noteInput.value.trim();
        noteInput.value = "";
        this.allianceAction("targets", {
          action: "add",
          x: cell.x,
          y: cell.y,
          world: String(this.viewedWorldId || this.session?.map?.worldid || ""),
          note,
        }, status);
      });
      targetRow.append(noteInput, addButton);
      sections.targets.appendChild(targetRow);
    } else {
      const hint = document.createElement("p");
      hint.className = "muted alliance-hint";
      hint.textContent = "Only officers and the leader can add or remove targets.";
      sections.targets.appendChild(hint);
    }

    // ---- Feed: shared war log (rendered separately, like chat) ----
    const feedHint = document.createElement("p");
    feedHint.className = "muted alliance-hint";
    feedHint.textContent = "Captures and losses involving allies and enemies, reported by every member's viewer. Entries expire after 14 days.";
    const feedList = document.createElement("div");
    feedList.className = "alliance-feed-list";
    feedList.id = "alliance-feed-list";
    sections.feed.append(feedHint, feedList);
    if (myRankValue >= RANK_VALUE.officer) {
      const clearFeed = document.createElement("button");
      clearFeed.type = "button";
      clearFeed.className = "secondary-button danger alliance-feed-clear";
      clearFeed.textContent = "Clear Feed";
      clearFeed.addEventListener("click", () => {
        if (window.confirm("Clear the entire alliance feed?")) {
          this.allianceAction("feed-clear", null, status);
        }
      });
      sections.feed.appendChild(clearFeed);
    }

    for (const section of Object.values(sections)) {
      container.appendChild(section);
    }
    container.appendChild(status);
    this.setAllianceTab(this.allianceActiveTab);
    this.renderAllianceFeed();

    this.renderAllianceChatLog();
  }

  // Identity block used by roster rows: Name | Rank | Server | N Outposts.
  // Rank is omitted for enemies (they have none).
  // Members render as:  Rank  Name  (x Outposts)  Server  Seen
  // Enemies render as:   [Alliance]  Name  (x Outposts)  Server  Seen
  // with the enemy's name in red.
  buildAllianceIdentity(entry, rank, { enemy = false } = {}) {
    const identity = document.createElement("div");
    identity.className = "alliance-identity";
    if (rank) {
      const pill = document.createElement("span");
      pill.className = `alliance-rank-pill rank-${rank}`;
      pill.textContent = rank.charAt(0).toUpperCase() + rank.slice(1);
      identity.appendChild(pill);
    }
    if (enemy && String(entry.alliance || "").trim()) {
      const tag = document.createElement("span");
      tag.className = "alliance-identity-tag";
      tag.textContent = `[${String(entry.alliance).trim()}]`;
      tag.title = `Member of ${String(entry.alliance).trim()}`;
      identity.appendChild(tag);
    }
    const name = document.createElement("span");
    name.className = ["alliance-identity-name", enemy ? "enemy-name" : "",
      this.nameRelationClass(entry.name)].filter(Boolean).join(" ");
    name.textContent = entry.name;
    name.title = entry.name;
    identity.appendChild(name);
    const outposts = document.createElement("span");
    outposts.className = "alliance-identity-meta";
    const count = Number(entry.outposts || 0);
    outposts.textContent = `(${formatNumber(count)} Outpost${count === 1 ? "" : "s"})`;
    identity.appendChild(outposts);
    const world = document.createElement("span");
    world.className = "alliance-identity-meta";
    world.textContent = this.allianceWorldName(entry.world) || "\u2014";
    world.title = entry.world ? `World ${entry.world}` : "World unknown (not in any cached map)";
    identity.appendChild(world);
    if (Number(entry.seenAt || 0) > 0) {
      const seen = document.createElement("span");
      seen.className = "alliance-identity-meta";
      seen.textContent = `seen ${formatRelativeTime(Number(entry.seenAt))}`;
      seen.title = "When any cached zone last contained this player's cells";
      identity.appendChild(seen);
    }
    return identity;
  }

  buildAllianceButton(label, title, onClick) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "game-button alliance-row-button alliance-game-btn";
    button.textContent = label;
    button.title = title;
    button.addEventListener("click", onClick);
    return button;
  }

  allianceWorldName(worldId) {
    const id = String(worldId || "").trim();
    if (!id) {
      return "";
    }
    const name = this.worldNameById?.get(id) || "";
    return name || `${id.slice(0, 8)}\u2026`;
  }

  // Jumps to a roster entry's main yard, switching the viewed world first
  // when they live on a different server (cached guest view, or back to the
  // live view when it is the signed-in player's own world).
  async jumpToAllianceYard(entry) {
    if (!entry?.main || !this.renderer) {
      return;
    }
    this.closeToolbarMenus();
    const targetWorld = String(entry.world || "").trim();
    if (targetWorld && targetWorld !== this.viewedWorldId) {
      const world = (this.worlds || []).find((candidate) => candidate.uuid === targetWorld)
        || { uuid: targetWorld, name: this.worldNameById?.get(targetWorld) || "" };
      await this.viewWorld(world);
      if (this.viewedWorldId !== targetWorld) {
        return; // switch failed (e.g. no cache for that world)
      }
    }
    this.renderer.jumpToCoordinates(Number(entry.main.x), Number(entry.main.y));
  }

  // Shows one alliance section, hides the rest, and clears the chat tab's
  // unread dot when it becomes active. Switching tabs never rebuilds the
  // panel, so half-typed input in any section is preserved.
  setAllianceTab(tab) {
    const key = ["chat", "members", "enemies", "targets", "feed"].includes(tab) ? tab : "chat";
    this.allianceActiveTab = key;
    if (!this.allianceSections || !this.allianceTabButtons) {
      return;
    }
    for (const [name, section] of Object.entries(this.allianceSections)) {
      section.hidden = name !== key;
      this.allianceTabButtons[name]?.classList.toggle("active", name === key);
    }
    if (key === "chat") {
      this.clearAllianceUnread();
      const log = document.getElementById("alliance-chat-log");
      if (log) {
        log.scrollTop = log.scrollHeight;
      }
    }
  }

  clearAllianceUnread() {
    this.allianceUnreadChat = 0;
    this.allianceTabButtons?.chat?.classList.remove("unread");
    this.updateAllianceBadge();
    // Persist the read position so a reload doesn't resurrect old messages
    // as unread.
    const readAt = Math.max(
      Number(this.userSettings?.allianceChatReadAt || 0),
      this.allianceChatLatest,
    );
    if (this.userSettings && readAt > Number(this.userSettings.allianceChatReadAt || 0)) {
      this.userSettings.allianceChatReadAt = readAt;
      this.scheduleSaveUserSettings();
    }
  }

  // Toolbar badge: pending invites (red) take priority over unread chat
  // (gold) - an invite is actionable even with the menu closed.
  updateAllianceBadge() {
    const badge = this.elements.allianceBadge;
    if (!badge) {
      return;
    }
    let text = "";
    let isInvite = false;
    if (!this.alliance && this.allianceInvites.length) {
      text = String(this.allianceInvites.length);
      isInvite = true;
    } else if (this.allianceUnreadChat > 0) {
      text = this.allianceUnreadChat > 99 ? "99+" : String(this.allianceUnreadChat);
    }
    badge.hidden = !text;
    badge.textContent = text;
    badge.classList.toggle("invite", isInvite);
  }

  renderAllianceFeed() {
    const list = document.getElementById("alliance-feed-list");
    if (!list) {
      return;
    }
    const feed = this.alliance?.feed || [];
    list.replaceChildren();
    if (!feed.length) {
      list.innerHTML = '<span class="muted">No activity recorded yet.</span>';
      return;
    }
    for (const event of feed) {
      const row = document.createElement("div");
      row.className = "alliance-feed-row";
      const verb = event.kind === "captured" ? "captured" : "lost";
      const linkWord = event.kind === "captured" ? "from" : "to";
      const actorCls = this.nameRelationClass(event.playerName);
      const otherCls = this.nameRelationClass(event.otherParty);
      row.innerHTML =
        `<strong class="${actorCls}">${escapeHtml(String(event.playerName || ""))}</strong> ${verb} ` +
        `a${/^[aeiou]/i.test(String(event.cellType || "")) ? "n" : ""} ${escapeHtml(String(event.cellType || "base"))} ` +
        `at ${Number(event.x)}, ${Number(event.y)} ${linkWord} ` +
        `<span class="${otherCls}">${escapeHtml(String(event.otherParty || "unknown"))}</span>` +
        `<div class="alliance-feed-meta">${escapeHtml(this.allianceWorldName(event.world) || "\u2014")} \u00b7 ` +
        `${escapeHtml(formatRelativeTime(Number(event.at || 0)))} \u00b7 seen by ${escapeHtml(String(event.by || "?"))}</div>`;
      row.title = `Jump to ${event.x}, ${event.y}`;
      row.addEventListener("click", () =>
        this.jumpToAllianceYard({ world: event.world, main: { x: event.x, y: event.y } }));
      list.appendChild(row);
    }
  }

  renderAllianceChatLog() {
    const log = document.getElementById("alliance-chat-log");
    if (!log) {
      return;
    }
    const wasAtBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 24;
    log.replaceChildren();
    if (!this.allianceChat.length) {
      log.innerHTML = '<span class="muted">No messages yet. Say hello!</span>';
      return;
    }
    for (const message of this.allianceChat) {
      const from = String(message.from || "");
      const meta = this.allianceMemberMeta?.get(from.trim().toLocaleLowerCase());
      const chatRel = this.nameRelationClass(from);
      let identity = `<strong class="alliance-chat-author${chatRel ? " " + chatRel : ""}">${escapeHtml(from)}</strong>`;
      if (meta) {
        const rank = String(meta.rank || "member");
        const count = Number(meta.outposts || 0);
        const parts = [
          rank.charAt(0).toUpperCase() + rank.slice(1),
          this.allianceWorldName(meta.world) || "\u2014",
          `${formatNumber(count)} Outpost${count === 1 ? "" : "s"}`,
        ];
        identity += ` <span class="alliance-chat-meta">| ${parts.map(escapeHtml).join(" | ")}</span>`;
      }
      const line = document.createElement("div");
      line.className = "alliance-chat-line";
      line.innerHTML =
        `${identity} ` +
        `<span class="alliance-chat-time">${escapeHtml(formatRelativeTime(Number(message.at || 0)))}</span>` +
        `<div>${escapeHtml(String(message.text || ""))}</div>`;
      log.appendChild(line);
    }
    if (wasAtBottom || log.scrollTop === 0) {
      log.scrollTop = log.scrollHeight;
    }
    this.paintAllianceNames();
  }

  // Names in the alliance panel wear their MAP colours: self #5aa9ff,
  // allies #34d6ec, enemies #ff5c4a (the enemy-name class covers those).
  // self / ally / enemy relation for a display name, matching map colours.
  // 1-based leaderboard rank for a player, matching the leaderboard's own
  // default order: the served rows first (hidden players excluded), then
  // cache-only players by explored outpost count. Returns null until the
  // served rows for the viewed world arrive; the first miss kicks off that
  // fetch (viewer-server data, cached per world - no game-API cost) and
  // re-renders the cell popup when it lands.
  getLeaderboardRank(name) {
    const low = String(name || "").trim().toLocaleLowerCase();
    const worldId = String(this.viewedWorldId || this.session?.map?.worldid || "").trim();
    if (!low || !worldId) return null;
    const rows = this.leaderboardCache.get(worldId);
    if (!rows) {
      this.getLeaderboardRows(worldId)
        .then(() => { if (this.selectedCell) this.renderDetails(); })
        .catch(() => {});
      return null;
    }
    const served = rows.filter((entry) => !this.isPlayerHidden(entry.username));
    const servedIndex = served.findIndex(
      (entry) => String(entry.username || "").trim().toLocaleLowerCase() === low);
    if (servedIndex >= 0) return servedIndex + 1;
    const servedSet = new Set(
      served.map((entry) => String(entry.username || "").trim().toLocaleLowerCase()));
    const tail = [...(this.renderer?.getOwnerOutpostCounts?.() || new Map()).entries()]
      .filter(([owner]) => owner && !servedSet.has(owner) && !this.isPlayerHidden(owner))
      .sort((a, b) => b[1] - a[1]);
    const tailIndex = tail.findIndex(([owner]) => owner === low);
    return tailIndex >= 0 ? served.length + 1 + tailIndex : null;
  }

  nameRelationClass(name) {
    const low = String(name || "").trim().toLocaleLowerCase();
    if (!low) return "";
    const own = String(this.session?.user?.username || "")
      .trim().toLocaleLowerCase();
    if (own && low === own) return "name-self";
    if (this.renderer?.highlightNames?.enemies?.has(low)) return "name-enemy";
    if (this.allianceEnemyLower?.has(low)) return "name-enemy";
    if (this.renderer?.highlightNames?.allies?.has(low)) return "name-ally";
    if (this.allianceMemberMeta?.has(low)) return "name-ally";
    return "";
  }

  paintAllianceNames() {
    const ownName = String(this.session?.user?.username || "")
      .trim().toLocaleLowerCase();
    if (!ownName) return;
    for (const el of document.querySelectorAll(
      ".dock-content .alliance-identity-name")) {
      const isSelf = el.textContent.trim().toLocaleLowerCase() === ownName;
      el.classList.toggle("name-self", isSelf);
    }
  }
}
