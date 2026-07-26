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
  TRIBE_FILTER_OPTIONS,
  TYPE_FILTER_OPTIONS,
  createEmptyBaseFilter,
  describeTribe,
  describeYardType,
  escapeHtml,
  fetchAdminStatus,
  setViewerAuthToken,
  fetchAnnouncement,
  fetchHiddenPlayers,
  getCellLootTotal,
  formatRelativeTime,
  storageGetUserSettings,
  storageListServers,
  storageGetServerMap,
  allianceMe,
  alliancePost,
  allianceChatFetch,
  fetchWorldActivity,
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

const MAP_REFRESH_COOLDOWN_MS = 60_000;
const MOBILE_LAYOUT_MEDIA_QUERY = "(max-width: 900px)";
const FILTER_MENU_TRANSITION_MS = 180;
const SEARCH_RESULTS_TRANSITION_MS = 180;
const DESKTOP_DETAILS_RESIZE_TRANSITION_MS = 180;
const MOBILE_DETAILS_RESIZE_TRANSITION_MS = 220;
const INITIAL_OVERLAY_MESSAGE = "Loading...";
const SIGNED_OUT_OVERLAY_MESSAGE = "Please log in.";


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
    this.refreshInFlight = false;
    this.tokenRecoveryPromise = null;
    this.refreshCooldownUntil = 0;
    this.refreshCooldownTimer = 0;
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
      filterTribeOptions: document.getElementById("filter-tribe-options"),
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
      refreshButton: document.getElementById("refresh-button"),
      refreshButtonCooldown: document.getElementById("refresh-button-cooldown"),
      findHomeButton: document.getElementById("find-home-button"),
      zoomInButton: document.getElementById("zoom-in-button"),
      zoomOutButton: document.getElementById("zoom-out-button"),
      jumpXInput: document.getElementById("jump-x-input"),
      jumpYInput: document.getElementById("jump-y-input"),
      jumpButton: document.getElementById("jump-button"),
      jumpStatus: document.getElementById("jump-status"),
      bookmarkNameInput: document.getElementById("bookmark-name-input"),
      bookmarkAddButton: document.getElementById("bookmark-add-button"),
      bookmarkHelp: document.getElementById("bookmark-help"),
      bookmarkList: document.getElementById("bookmark-list"),
      measureButton: document.getElementById("measure-button"),
      measureStatus: document.getElementById("measure-status"),
      scanButton: document.getElementById("scan-button"),
      scanProgress: document.getElementById("scan-progress"),
      scanProgressFill: document.getElementById("scan-progress-fill"),
      scanStatus: document.getElementById("scan-status"),
      watchRefreshToggle: document.getElementById("watch-refresh-toggle"),
      watchClearButton: document.getElementById("watch-clear-button"),
      watchLists: {
        allies: {
          captured: document.getElementById("watch-allies-captured"),
          lost: document.getElementById("watch-allies-lost"),
        },
      },
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
    this.elements.logoutButton.addEventListener("click", () => this.handleLogout());
    // The corner reload control was removed; the refresh path is still
    // reachable programmatically, so everything downstream stays null-safe
    // rather than being deleted.
    this.elements.refreshButton?.addEventListener("click", () => this.handleRefreshMap());
    this.elements.findHomeButton.addEventListener("click", () => this.renderer.focusHome());
    this.elements.zoomInButton.addEventListener("click", () => this.renderer.zoomBy(1.18, true));
    this.elements.zoomOutButton.addEventListener("click", () => this.renderer.zoomBy(1 / 1.18, true));
    this.elements.mobileDetailsCloseButton.addEventListener("click", () => this.handleMobileDetailsClose());
    this.elements.detailsCloseButton?.addEventListener("click", () => this.closeCellDetails());
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
    this.elements.watchRefreshToggle.addEventListener("change", () => this.handleWatchToggle());
    this.elements.watchClearButton.addEventListener("click", () => this.clearWatchEvents());
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
    this.elements.filterTribeOptions.addEventListener("change", (event) => this.handleFilterOptionChange(event));
    this.elements.filterLevelMinInput.addEventListener("input", (event) => this.handleLevelRangeInput(event));
    this.elements.filterLevelMaxInput.addEventListener("input", (event) => this.handleLevelRangeInput(event));
    this.elements.filterOutpostInput.addEventListener("input", (event) => this.handleOutpostFilterInput(event));
    this.elements.filterOutpostMaxInput.addEventListener("input", (event) => this.handleOutpostFilterInput(event));
    document.addEventListener("pointerdown", (event) => this.handleGlobalPointerDown(event));
    const closeFloatingMenus = () => {
      this.closeToolbarMenus();
      if (this.filterMenuOpen) {
        this.setFilterMenuOpen(false);
      }
    };
    document.querySelector(".toolbar-scroll")?.addEventListener("scroll", closeFloatingMenus, { passive: true });
    window.addEventListener("resize", closeFloatingMenus);
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
    this.refreshInFlight = false;
    this.refreshCooldownUntil = 0;
    this.clearRefreshCooldownTimer();
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
      // Let the API client recover from a rotated/expired session on its own.
      this.api.getCurrentToken = () => this.session?.token || "";
      this.api.refreshSession = () => this.recoverSessionToken();
    } else {
      this.renderer.api = this.api;
      this.renderer.assets = this.assets;
    }

    this.setPendingSessionState();
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
      this.guestAttemptId += 1;
      this.isGuestView = false;
      this.viewedWorldId = String(session?.map?.worldid || "").trim() || null;
      // Present the session token to the viewer server BEFORE any per-user
      // storage call: those endpoints now verify the token (which rotates it
      // once). loadModerationState adopts the rotated token, so the settings
      // and login-record requests below hit the server's token cache instead
      // of triggering further rotations.
      setViewerAuthToken(session.token || "");
      await this.loadModerationState();
      await this.loadUserSettings(session.user.username);
      this.elements.loginForm.hidden = true;
      this.elements.sessionPanel.classList.add("signed-in");
      this.elements.sessionSignedIn.hidden = false;
      this.elements.sessionNameDisplay.textContent = session.user.username || "Signed in";
      this.elements.accountButton.hidden = true;
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
      this.refreshCooldownUntil = 0;
      this.clearRefreshCooldownTimer();
      this.setSessionStatus("");
      this.setSearchEnabled(false, "Loading nearby map zones...");
      this.setFilterEnabled(false);
      // Watch history must be in memory before the bootstrap refetch runs:
      // ownership changes detected while bootstrapping call recordWatchEvents,
      // which saves this.watchEvents back to storage. Loading afterwards would
      // let that save overwrite the stored history with only the new events.
      this.loadWatchEvents();
      this.applyHighlightsToRenderer();
      session.viewState = this.loadViewState(session);
      this.renderer.onViewStateChanged = (state) => this.saveViewState(state);
      this.renderer.onCellOwnershipChanges = (changes) => this.recordWatchEvents(changes);
      this.renderer.onMeasureUpdated = (state) => this.updateMeasureStatus(state);
      debugLog("Bootstrapping map renderer...");
      await this.renderer.bootstrap(session);
      debugLog("Renderer bootstrap complete; zones loaded:", this.renderer.loadedZones?.size ?? 0, "cells cached:", this.renderer.cellCache?.size ?? 0);
      this.rebuildSearchIndex();
      const hasSavedFilters = this.loadFilterState();
      this.rebuildFilterOptions(hasSavedFilters);
      this.updateRefreshButtonState();
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
      viewState: {},
      watchEvents: {},
      allianceChatReadAt: 0,
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
        viewState: { ...(source.viewState || {}) },
        watchEvents: { ...(source.watchEvents || {}) },
        allianceChatReadAt: Number(source.allianceChatReadAt || 0),
      };
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
    this.refreshInFlight = false;
    this.refreshCooldownUntil = 0;
    this.clearRefreshCooldownTimer();
    storageRemove(buildTokenStorageKey(this.config));
    this.session = null;
    this.setSignedOutState({ sessionStatus: message });
  }

  // NOTE: nothing calls this at present. The corner reload control was
  // removed and no replacement was bound, so the ally-zone refresh below is
  // reachable only from the console. Kept intact rather than deleted: it is
  // working behaviour, and re-binding it to a toolbar item is one line.
  async handleRefreshMap() {
    if (!this.session || this.isGuestView || !this.renderer || this.refreshInFlight) {
      return;
    }

    if (Date.now() < this.refreshCooldownUntil) {
      this.updateRefreshButtonState();
      return;
    }

    this.refreshInFlight = true;
    this.updateRefreshButtonState();

    try {
      // Refresh only the zones that hold the signed-in player's own bases
      // and their alliance members' bases/outposts, instead of the whole
      // viewport - that is what changes and what the refresh budget is for.
      const zones = this.collectAllyZoneOrigins(400);
      if (zones.length) {
        this.renderer.setOverlay(`Refreshing ${zones.length} zone${zones.length === 1 ? "" : "s"} with alliance bases...`);
        await this.renderer.refetchZones(zones);
        this.renderer.setOverlay("");
      } else {
        // Degenerate case (nothing owned in cache yet): keep the old
        // viewport refresh so the button is never a no-op.
        await this.renderer.refreshMapData();
      }
      this.rebuildSearchIndex();
      this.rebuildFilterOptions(true);
      this.renderDetails();
      this.startRefreshCooldown();
    } catch (error) {
      console.error(error);
      const sessionToken = this.session?.token || null;
      this.renderer.setOverlay(error.message || "Failed to refresh world map.");
      window.setTimeout(() => {
        if (this.session?.token === sessionToken && !this.refreshInFlight) {
          this.renderer?.setOverlay("");
        }
      }, 2200);
    } finally {
      this.refreshInFlight = false;
      this.updateRefreshButtonState();
    }
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

    for (const world of this.worlds) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "world-card";
      if (world.uuid === this.selectedWorldId) {
        button.classList.add("active");
      }
      const isViewing = this.viewedWorldId === world.uuid;
      if (isViewing) {
        button.classList.add("viewing");
      }

      const meta = isViewing
        ? "Currently viewing this world"
        : "Switch to viewing this world";

      button.innerHTML = `
        <strong>${escapeHtml(world.name || "Unnamed World")}</strong>
        <div class="muted">Players: ${formatNumber(Number(world.playerCount || 0))}</div>
        <div class="world-card-meta${isViewing ? " viewing" : ""}">${escapeHtml(meta)}</div>
      `;
      button.addEventListener("click", async () => {
        this.selectedWorldId = world.uuid;
        this.saveUiPref(`world:${this.config?.bymBaseUrl || ""}`, world.uuid);
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
    this.updateRefreshButtonState();
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

      const header = document.createElement("div");
      header.className = "leaderboard-row leaderboard-header";
      header.innerHTML = `
        <span class="leaderboard-rank">#</span>
        <span></span>
        <span class="leaderboard-name">Username</span>
        <span class="leaderboard-count">Outposts</span>
      `;
      this.elements.leaderboardList.appendChild(header);

      rows.forEach((entry, index) => {
        const row = document.createElement("div");
        row.className = "leaderboard-row";
        const rank = document.createElement("strong");
        rank.className = "leaderboard-rank";
        rank.textContent = String(index + 1);
        row.appendChild(rank);

        // Jump: resolve the player's main yard from the explored-base index
        // of the world on screen. Unexplored players can't be jumped to.
        const jump = document.createElement("button");
        jump.type = "button";
        jump.className = "leaderboard-jump";
        jump.textContent = "\u2316";
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
        name.className = "leaderboard-name";
        name.textContent = username || "Unknown";
        name.title = username || "Unknown";
        row.appendChild(name);

        const count = document.createElement("span");
        count.className = "leaderboard-count";
        count.textContent = formatNumber(Number(entry.outpost_count || 0));
        row.appendChild(count);
        this.elements.leaderboardList.appendChild(row);
      });
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
        return rows;
      })
      .finally(() => {
        this.leaderboardRequests.delete(worldId);
      });

    this.leaderboardRequests.set(worldId, request);
    return request;
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
      const known = cached !== undefined;
      const value = Number(cached?.v || 0);
      return {
        x, y,
        baseid: String(baseid || cached?.bid || ""),
        value,
        isMain,
        known,
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

    return [...main, ...outposts];
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
    } else {
      for (const [label, value] of this.buildDetailRows(cell)) {
        const row = document.createElement("div");
        row.className = "detail-row";
        row.innerHTML = `<span class="detail-label">${escapeHtml(label)}</span><span>${escapeHtml(value)}</span>`;
        contentEl.appendChild(row);
      }
    }

    const actions = document.createElement("div");
    actions.className = "detail-actions";

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
        const viewBaseButton = document.createElement("button");
        viewBaseButton.type = "button";
        viewBaseButton.className = "secondary-button";
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
            this.openToolbarMenu("menu-account");
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
    linkButton.className = "secondary-button";
    linkButton.textContent = "Copy Link to Cell";
    linkButton.addEventListener("click", () => this.copyCellLink(cell, linkButton));
    actions.appendChild(linkButton);

    contentEl.appendChild(actions);
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

    // Avatar: the game's own picture from the cached main-base cell, falling
    // back through the profile store to the game placeholder, exactly as the
    // profile panel resolves it.
    const profile = ownerId > 0 ? this.renderer?.getPlayerProfile(ownerId) : null;
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
    contentEl.appendChild(photo);

    // Owner line: the player's level comes from their main yard, so an
    // outpost shows the owner's level rather than the outpost's own.
    const mainCell = profile?.main || (isMain ? cell : null);
    const playerLevel = Number((mainCell || cell).l || 0);
    const allianceName = this.getPlayerAllianceName(name);
    const ownerLine = document.createElement("p");
    ownerLine.className = "cell-owner-line";
    ownerLine.textContent = `${name || `Player ${ownerId}`} (${formatNumber(playerLevel)})`
      + (allianceName ? ` - ${allianceName}` : "");
    contentEl.appendChild(ownerLine);

    const addLine = (text, className = "cell-line") => {
      const line = document.createElement("p");
      line.className = className;
      line.textContent = text;
      contentEl.appendChild(line);
      return line;
    };
    const addRule = () => {
      const rule = document.createElement("div");
      rule.className = "cell-rule";
      contentEl.appendChild(rule);
    };

    addLine(`${isMain ? "Main Yard" : "Outpost"} at ${cell.x},${cell.y}`);

    const counts = ownerId > 0
      ? (this.renderer?.getOwnedBaseCounts(ownerId) || { outpost: 0 })
      : { outpost: 0 };
    addLine(`Total Outposts: ${formatNumber(counts.outpost)}`);

    // Outposts point back to their owner's main yard, with the same Jump
    // control the alliance roster uses, so the affordance is identical
    // wherever a jump is offered.
    if (!isMain && mainCell) {
      const line = document.createElement("p");
      line.className = "cell-line cell-line-jump";
      line.append(`Main Yard at ${mainCell.x},${mainCell.y} `);
      // jumpToCoordinates centres the map, drops the jump marker, and selects
      // the cell (firing onSelectCell), so the panel refreshes on its own.
      line.appendChild(this.buildAllianceButton(
        "Jump",
        `Jump to ${name || "this player"}'s main yard`,
        () => this.renderer?.jumpToCoordinates(Number(mainCell.x), Number(mainCell.y)),
      ));
      contentEl.appendChild(line);
    }

    addRule();

    if (!isMain) {
      // getarea reports v per cell from that cell's own save, so cell.v is
      // this outpost's empire value. The profile's empireValue is the MAX
      // across the owner's cells - almost always their main yard - which
      // would classify every outpost of a large player as Ultra.
      addLine(`Kit: ${this.describeOutpostKit(Number(cell.v || 0))}`);
    }

    const observedAt = this.getCellObservedAt(cell);
    addLine(`Cell last updated: ${observedAt > 0 ? formatRelativeTime(observedAt) : "unknown"}`);
    addLine(`Damage: ${formatNumber(Number(cell.dm || 0))}%`);

    const flingerLevel = Number(cell.f || 0);
    const flingerRange = getFlingerRange(cell.f, isMain);
    addLine(`Flinger Range: ${formatNumber(flingerRange)} cells (level ${formatNumber(flingerLevel)})`);

    // Loot is raid intel: administrator-only, and only while "Show loot in
    // cell info" is ticked. Owned cells render through this summary rather
    // than buildDetailRows, so gating only the latter left the toggle doing
    // nothing on exactly the cells it matters for. Within that, every
    // resource is listed even at zero so the absence of loot is itself
    // readable rather than ambiguous.
    if (this.isViewerAdmin && this.showLootInfo) {
      addRule();
      addLine(`Loot: ${formatNumber(getCellLootTotal(cell))}`);
      for (const [key, label] of [["r1", "Twigs"], ["r2", "Pebbles"], ["r3", "Putty"], ["r4", "Goo"]]) {
        addLine(`${label}: ${formatNumber(Number(cell.r?.[key] || 0))}`);
      }
    }

    addRule();
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
    for (const group of ["allies"]) {
      for (const kind of ["captured", "lost"]) {
        for (const event of this.watchEvents?.[group]?.[kind] || []) {
          const actor = String(event.playerName || "").trim().toLocaleLowerCase();
          const other = String(event.otherParty || "").trim().toLocaleLowerCase();
          if (profileName && (actor === profileName || other === profileName)) {
            history.push({ ...event, kind, actorIsProfile: actor === profileName });
          }
        }
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
        const verb = event.kind === "captured"
          ? (event.actorIsProfile ? "captured" : "lost to")
          : (event.actorIsProfile ? "lost" : "took from");
        const counterpart = event.actorIsProfile ? event.otherParty : event.playerName;
        entry.innerHTML =
          `<span>${verb} ${escapeHtml(String(event.cellType || "a base"))} at ${Number(event.x)}, ${Number(event.y)}` +
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
    const value = Number(empireValue || 0);
    if (value >= 32_014_667) return "Ultra";
    if (value >= 11_947_752) return "Mega";
    if (value >= 2_408_160) return "Regular";
    return "None";
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
    if (this.isViewerAdmin && this.showLootInfo) {
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

  loadViewState(session) {
    const worldKey = String(session?.map?.worldid || "default");
    const parsed = this.userSettings?.viewState?.[worldKey] || null;
    if (parsed && Number.isFinite(Number(parsed.x)) && Number.isFinite(Number(parsed.y))) {
      debugLog("Restoring last camera position:", parsed);
      return parsed;
    }

    return null;
  }

  saveViewState(state) {
    if (!this.session || !this.userSettings) {
      return;
    }

    this.userSettings.viewState[this.getWorldSettingsKey()] = state;
    this.scheduleSaveUserSettings();
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

  saveUiPref(key, value) {
    try {
      const prefs = this.loadUiPrefs();
      prefs[key] = value;
      window.localStorage.setItem(UI_PREFS_STORAGE_KEY, JSON.stringify(prefs));
    } catch (error) {
      console.warn("[BYM-MR2] Failed to save UI preference.", error);
    }
  }

  setNavEnabled(enabled) {
    const isEnabled = Boolean(enabled);
    this.elements.jumpXInput.disabled = !isEnabled;
    this.elements.jumpYInput.disabled = !isEnabled;
    this.elements.jumpButton.disabled = !isEnabled;
    this.elements.findHomeButton.disabled = !isEnabled;
    this.elements.bookmarkNameInput.disabled = !isEnabled;
    this.elements.bookmarkAddButton.disabled = !isEnabled;

    this.elements.measureButton.disabled = !isEnabled;
    this.elements.scanButton.disabled = !isEnabled;
    this.elements.watchRefreshToggle.disabled = !isEnabled;
    this.elements.watchClearButton.disabled = !isEnabled;

    if (isEnabled) {
      const maxX = (this.renderer?.getMapWidth() || 800) - 1;
      const maxY = (this.renderer?.getMapHeight() || 800) - 1;
      this.elements.jumpXInput.max = String(maxX);
      this.elements.jumpYInput.max = String(maxY);
      this.elements.jumpStatus.textContent = `Jump to any cell (0-${maxX}, 0-${maxY}); coordinates wrap around the map edges.`;
      const uiPrefs = this.loadUiPrefs();
      this.elements.watchRefreshToggle.checked = uiPrefs.watchAutoRefresh !== false;
      const validLoot = ["total", "r1", "r2", "r3", "r4"];
      this.lootResource = validLoot.includes(uiPrefs.lootResource) ? uiPrefs.lootResource : "total";
      this.toggleLootDisplay(uiPrefs.showLoot === true);
      this.toggleLootInfo(uiPrefs.showLootInfo === true);
    } else {
      this.elements.jumpStatus.textContent = "Sign in to jump to cells.";
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
    this.elements.measureButton.textContent = this.measureActive ? "Stop Measuring" : "Measure Distance";
    this.elements.measureStatus.hidden = !this.measureActive;
    if (this.measureActive) {
      this.elements.measureStatus.textContent = "Click two cells on the map.";
    }
    this.renderer?.setMeasureMode(this.measureActive);
  }

  updateMeasureStatus({ a, b, distance } = {}) {
    if (!this.measureActive) {
      return;
    }

    if (a && b && distance !== null) {
      this.elements.measureStatus.textContent =
        `${a.x}, ${a.y}  ->  ${b.x}, ${b.y}: ${formatNumber(distance)} cells (wrap-aware). Click again to restart.`;
    } else if (a) {
      this.elements.measureStatus.textContent = `First point ${a.x}, ${a.y}. Click the second cell.`;
    } else {
      this.elements.measureStatus.textContent = "Click two cells on the map.";
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
    return {
      allies: { captured: [], lost: [] },
    };
  }

  loadWatchEvents() {
    this.watchEvents = this.createEmptyWatchEvents();
    const stored = this.userSettings?.watchEvents?.[this.getWorldSettingsKey()] || null;
    for (const group of ["allies"]) {
      for (const kind of ["captured", "lost"]) {
        const list = stored?.[group]?.[kind];
        if (Array.isArray(list)) {
          this.watchEvents[group][kind] = list.slice(0, MR2.watchEventListLimit);
        }
      }
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
    // Watched = the signed-in player only: watch covers your own main yard
    // and outposts. Alliance members are visible in the alliance panel and
    // feed but no longer generate watch activity or notifications.
    const allies = new Set();
    const ownName = String(this.session?.user?.username || "").trim().toLocaleLowerCase();
    if (ownName) {
      allies.add(ownName);
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

    for (const change of changes) {
      const prevName = String(change.previous?.n || "").trim().toLocaleLowerCase();
      const currName = String(change.current?.n || "").trim().toLocaleLowerCase();
      const prevOwned = Number(change.previous?.uid || 0) > 0;
      const currOwned = Number(change.current?.uid || 0) > 0;

      for (const group of ["allies"]) {
        // Captured: a watched player now owns a cell they did not own before.
        if (currOwned && watched[group].has(currName) && (!prevOwned || prevName !== currName)) {
          if (this.isPlayerHidden(change.current?.n) || this.isPlayerHidden(describe(change.previous))) {
            continue;
          }
          this.pushWatchEvent(group, "captured", {
            playerName: String(change.current.n).trim(),
            x: change.x,
            y: change.y,
            cellType: Number(change.current.b) === MR2.yardTypes.main ? "main yard" : "outpost",
            level: Number(change.current.l || 0),
            otherParty: describe(change.previous),
            at: Date.now(),
          });
          toNotify.push({
            body: `${String(change.current.n).trim()} captured a${Number(change.current.b) === MR2.yardTypes.main ? " main yard" : "n outpost"} at ${change.x}, ${change.y} from ${describe(change.previous)}`,
            x: change.x,
            y: change.y,
          });
          recorded += 1;
        }

        // Lost: a watched player owned this cell before and no longer does.
        if (prevOwned && watched[group].has(prevName) && (!currOwned || currName !== prevName)) {
          this.pushWatchEvent(group, "lost", {
            playerName: String(change.previous.n).trim(),
            x: change.x,
            y: change.y,
            cellType: Number(change.previous.b) === MR2.yardTypes.main ? "main yard" : "outpost",
            level: Number(change.previous.l || 0),
            otherParty: describe(change.current),
            at: Date.now(),
          });
          toNotify.push({
            body: `${String(change.previous.n).trim()} lost a${Number(change.previous.b) === MR2.yardTypes.main ? " main yard" : "n outpost"} at ${change.x}, ${change.y} to ${describe(change.current)}`,
            x: change.x,
            y: change.y,
          });
          recorded += 1;
        }
      }
    }

    this.reportAllianceFeedEvents(changes);

    if (recorded > 0) {
      debugLog(`Watchlist recorded ${recorded} ownership event(s).`);
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

  pushWatchEvent(group, kind, event) {
    const list = this.watchEvents[group][kind];
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

  renderWatchActivity() {
    for (const group of ["allies"]) {
      for (const kind of ["captured", "lost"]) {
        const container = this.elements.watchLists[group][kind];
        container.replaceChildren();

        const events = this.watchEvents[group][kind];
        if (!this.session) {
          container.innerHTML = '<span class="watch-empty">Sign in to track activity.</span>';
          continue;
        }

        if (!events.length) {
          container.innerHTML = '<span class="watch-empty">Nothing yet.</span>';
          continue;
        }

        for (const event of events.slice(0, 12)) {
          const button = document.createElement("button");
          button.type = "button";
          button.className = "watch-event";
          const action = kind === "captured"
            ? `captured ${escapeHtml(event.cellType)} at ${event.x}, ${event.y} from ${escapeHtml(event.otherParty)}`
            : `lost ${escapeHtml(event.cellType)} at ${event.x}, ${event.y} to ${escapeHtml(event.otherParty)}`;
          button.innerHTML = `<strong>${escapeHtml(event.playerName)}</strong> ${action} <span class="watch-time">${escapeHtml(formatRelativeTime(event.at))}</span>`;
          button.title = `Jump to ${event.x}, ${event.y}`;
          button.addEventListener("click", () => {
            this.renderer?.jumpToCoordinates(event.x, event.y);
          });
          container.appendChild(button);
        }
      }
    }
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
    debugLog("Watchlist armed: cached checks every 10 min, live burst hourly.");
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
  }

  // Zones containing any cell owned by the signed-in player or an alliance
  // member, capped at `limit`. Used by the watch cycle, and by
  // handleRefreshMap - which currently has no control bound to it (see
  // below).
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
    return [...zoneOrigins.values()];
  }

  async runWatchCycle(mode = "live") {
    if (!this.session || this.isGuestView || !this.renderer || this.watchCycleInFlight || this.scanRunning) {
      return;
    }

    const origins = this.collectAllyZoneOrigins(MR2.watchMaxZonesPerCycle);
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
        debugLog(`Watchlist LIVE refresh: re-fetching ${origins.length} zone(s).`);
        await this.renderer.refetchZones(origins);
      }
      this.renderWatchActivity();
    } finally {
      this.watchCycleInFlight = false;
    }
  }

  handleJump() {
    if ((!this.session && !this.isGuestView) || !this.renderer) {
      return;
    }

    const rawX = this.elements.jumpXInput.value.trim();
    const rawY = this.elements.jumpYInput.value.trim();
    const x = Number.parseInt(rawX, 10);
    const y = Number.parseInt(rawY, 10);

    if (!rawX || !rawY || Number.isNaN(x) || Number.isNaN(y)) {
      this.elements.jumpStatus.textContent = "Enter both X and Y coordinates.";
      return;
    }

    const target = this.renderer.jumpToCoordinates(x, y);
    debugLog("Jumping to cell", target);
    this.elements.jumpStatus.textContent = `Jumped to ${target.x}, ${target.y}.`;
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

  handleAddBookmark() {
    if (!this.session || !this.renderer) {
      return;
    }

    const selected = this.renderer.getSelectedCell();
    const marker = this.renderer.jumpMarker;
    const target = selected
      ? { x: selected.x, y: selected.y }
      : marker
        ? { x: marker.x, y: marker.y }
        : this.renderer.getCenterCell();

    if (!target) {
      return;
    }

    const suggestedName = selected && String(selected.n || "").trim()
      ? String(selected.n).trim()
      : `${target.x}, ${target.y}`;
    const name = (this.elements.bookmarkNameInput.value.trim() || suggestedName).slice(0, 40);

    const existingIndex = this.bookmarks.findIndex((entry) => entry.x === target.x && entry.y === target.y);
    if (existingIndex !== -1) {
      this.bookmarks[existingIndex] = { ...this.bookmarks[existingIndex], name };
    } else {
      this.bookmarks.push({ name, x: target.x, y: target.y, createdAt: Date.now() });
    }

    this.elements.bookmarkNameInput.value = "";
    this.saveBookmarks();
    this.renderBookmarks();
    debugLog("Bookmark saved:", name, target);
    this.elements.bookmarkHelp.textContent = `Saved "${name}" at ${target.x}, ${target.y}.`;
  }

  removeBookmark(index) {
    const removed = this.bookmarks.splice(index, 1)[0];
    this.saveBookmarks();
    this.renderBookmarks();
    if (removed) {
      debugLog("Bookmark removed:", removed.name);
    }
  }

  renderBookmarks() {
    const container = this.elements.bookmarkList;
    container.replaceChildren();

    if (!this.session) {
      container.innerHTML = '<span class="bookmark-empty">Sign in to manage bookmarks.</span>';
      return;
    }

    if (!this.bookmarks.length) {
      container.innerHTML = '<span class="bookmark-empty">No bookmarks yet. Select a cell and press Add.</span>';
      return;
    }

    this.bookmarks.forEach((bookmark, index) => {
      const row = document.createElement("div");
      row.className = "bookmark-row";

      const jumpButton = document.createElement("button");
      jumpButton.type = "button";
      jumpButton.className = "bookmark-jump";
      jumpButton.title = `Jump to ${bookmark.x}, ${bookmark.y}`;
      jumpButton.innerHTML = `<span class="bookmark-name">${escapeHtml(bookmark.name)}</span><span class="bookmark-coords">${bookmark.x}, ${bookmark.y}</span>`;
      jumpButton.addEventListener("click", () => {
        if (!this.renderer) {
          return;
        }
        this.renderer.jumpToCoordinates(bookmark.x, bookmark.y);
      });

      const deleteButton = document.createElement("button");
      deleteButton.type = "button";
      deleteButton.className = "bookmark-delete";
      deleteButton.title = "Delete bookmark";
      deleteButton.textContent = "\u00d7";
      deleteButton.addEventListener("click", () => this.removeBookmark(index));

      row.append(jumpButton, deleteButton);
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
    this.availableOutpostMax = Math.max(0, ...this.ownerOutpostCounts.values());
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
        playerOwnerId: validOwnerIds.has(Number(this.filterState.playerOwnerId || 0))
          ? Number(this.filterState.playerOwnerId || 0)
          : null,
        playerUsername: validOwnerIds.has(Number(this.filterState.playerOwnerId || 0))
          ? this.filterState.playerUsername
          : "",
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
          this.filterMenuCloseTimer = 0;
        }, FILTER_MENU_TRANSITION_MS);
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
    const rawQuery = this.elements.filterPlayerInput.value.trim();
    if (!rawQuery) {
      this.playerFilterMatches = [];
      this.playerFilterActiveIndex = -1;
      this.hidePlayerFilterResults();
      if (this.filterState.playerOwnerId) {
        this.filterState = {
          ...this.filterState,
          playerOwnerId: null,
          playerUsername: "",
        };
        this.applyFilters();
      }
      this.renderFilterOptions();
      return;
    }

    let didChangeFilterState = false;
    if (
      Number(this.filterState.playerOwnerId || 0) > 0 &&
      rawQuery !== String(this.filterState.playerUsername || "")
    ) {
      this.filterState = {
        ...this.filterState,
        playerOwnerId: null,
        playerUsername: "",
      };
      didChangeFilterState = true;
    }

    if (this.filterState.tribes.length > 0) {
      this.filterState = {
        ...this.filterState,
        tribes: [],
      };
      didChangeFilterState = true;
    }

    this.renderFilterOptions();
    if (didChangeFilterState) {
      this.applyFilters();
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
    return this.getRankedSearchMatches(this.playerFilterEntries, query);
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
    this.filterState = {
      ...this.filterState,
      tribes: [],
      playerOwnerId: entry.ownerId,
      playerUsername: entry.username,
    };
    this.renderFilterOptions();
    this.applyFilters();
    this.hidePlayerFilterResults();
  }

  handleFilterOptionChange(event) {
    const input = event.target;
    if (!(input instanceof HTMLInputElement)) {
      return;
    }

    const group = input.dataset.group;
    if (!group || !["types", "tribes"].includes(group)) {
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

    if (this.hasWildMonsterTribeTypeFilter()) {
      this.filterState = {
        ...this.filterState,
        playerOwnerId: null,
        playerUsername: "",
      };
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
    const section = this.elements.filterOutpostRange.closest(".filter-section");
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
    const world = String(this.selectedWorldId || this.session?.map?.worldid || "");
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
    return { ...this.filterState, inactiveNames, bigOwners };
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

    this.userSettings.filters[this.getWorldSettingsKey()] = this.filterState;
    this.scheduleSaveUserSettings();
  }

  loadFilterState() {
    try {
      const parsed = this.userSettings?.filters?.[this.getWorldSettingsKey()] || null;
      if (!parsed || typeof parsed !== "object") {
        return false;
      }

      this.filterState = {
        ...createEmptyBaseFilter(),
        types: Array.isArray(parsed.types) ? parsed.types.map(String) : [],
        tribes: Array.isArray(parsed.tribes) ? parsed.tribes.map(String) : [],
        levelMin: Number(parsed.levelMin || 0) > 0 ? Number(parsed.levelMin) : null,
        levelMax: Number(parsed.levelMax || 0) > 0 ? Number(parsed.levelMax) : null,
        outpostMin: Number(parsed.outpostMin || 0) > 0 ? Number(parsed.outpostMin) : null,
        outpostMax: (parsed.outpostMax ?? null) !== null ? Math.max(0, Number(parsed.outpostMax)) : null,
        playerOwnerId: Number(parsed.playerOwnerId || 0) > 0 ? Number(parsed.playerOwnerId) : null,
        playerUsername: String(parsed.playerUsername || ""),
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

  renderFilterOptions() {
    const filterEnabled = !this.elements.filterToggleButton.disabled;
    this.renderPlayerFilterOptions(filterEnabled && !this.hasWildMonsterTribeTypeFilter());
    this.renderFilterGroup(this.elements.filterTypeOptions, "types", TYPE_FILTER_OPTIONS, filterEnabled);
    this.renderFilterGroup(
      this.elements.filterTribeOptions,
      "tribes",
      TRIBE_FILTER_OPTIONS,
      filterEnabled && !this.hasPlayerFilterQuery(),
    );
    this.renderLevelFilterControls(filterEnabled);
    this.renderOutpostFilterControls(filterEnabled);
    this.elements.filterClearButton.disabled = !hasActiveBaseFilterState(this.filterState);
  }

  renderPlayerFilterOptions(enabled) {
    const section = this.elements.filterPlayerInput.closest(".filter-section");
    const shell = this.elements.filterPlayerInput.closest(".filter-player-shell");
    this.elements.filterPlayerInput.disabled = !enabled;
    if (section) {
      section.classList.toggle("disabled", !enabled);
    }
    if (shell) {
      shell.classList.toggle("disabled", !enabled);
    }
    if (Number(this.filterState.playerOwnerId || 0) > 0) {
      this.elements.filterPlayerInput.value = this.filterState.playerUsername || "";
    } else if (!enabled) {
      this.elements.filterPlayerInput.value = "";
    } else if (document.activeElement !== this.elements.filterPlayerInput) {
      this.elements.filterPlayerInput.value = "";
    }
    this.elements.filterPlayerInput.placeholder = enabled
      ? "Filter by username"
      : "Unavailable for wild monster tribe";

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
    const section = this.elements.filterLevelRange.closest(".filter-section");
    const rangeEnabled = enabled && this.availableFilterLevels.length > 0;

    if (section) {
      section.classList.toggle("disabled", !rangeEnabled);
    }
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
      Number(this.filterState.playerOwnerId || 0) > 0 ||
      Boolean(this.elements.filterPlayerInput.value.trim())
    );
  }

  hasWildMonsterTribeTypeFilter() {
    return this.filterState.types.includes("wild");
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
    if (this.filterState.types.length) {
      const labels = TYPE_FILTER_OPTIONS
        .filter((option) => this.filterState.types.includes(option.key))
        .map((option) => option.label);
      segments.push(`Type: ${labels.join(", ")}`);
    }

    if (this.filterState.tribes.length) {
      const labels = TRIBE_FILTER_OPTIONS
        .filter((option) => this.filterState.tribes.includes(option.key))
        .map((option) => option.label);
      segments.push(`Tribe: ${labels.join(", ")}`);
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

    if (this.filterState.playerUsername) {
      segments.push(`Player: ${this.filterState.playerUsername}`);
    }

    this.elements.filterStatus.textContent = segments.join(" | ");
  }

  updateRefreshButtonState() {
    const button = this.elements.refreshButton;
    const cooldownBadge = this.elements.refreshButtonCooldown;
    if (!button) {
      return;
    }
    // Refresh needs a live view of the user's own world; cached guest views
    // (signed in or not) cannot pull fresh data.
    const hasSession = Boolean(this.session) && !this.isGuestView;
    const cooldownSeconds = Math.max(0, Math.ceil((this.refreshCooldownUntil - Date.now()) / 1000));
    const isCoolingDown = cooldownSeconds > 0;

    button.disabled = !hasSession || this.refreshInFlight || isCoolingDown;
    button.classList.toggle("cooling-down", isCoolingDown);
    button.classList.toggle("loading", this.refreshInFlight);
    cooldownBadge.hidden = !isCoolingDown;
    cooldownBadge.textContent = isCoolingDown ? String(cooldownSeconds) : "";

    if (!hasSession) {
      const reason = this.session
        ? "Return to your own world to refresh the map"
        : "Sign in to refresh the world map";
      button.title = reason;
      button.setAttribute("aria-label", reason);
      this.elements.findHomeButton.disabled = true;
      return;
    }

    this.elements.findHomeButton.disabled = false;

    if (this.refreshInFlight) {
      button.title = "Refreshing alliance zones...";
      button.setAttribute("aria-label", "Refreshing world map");
      return;
    }

    if (isCoolingDown) {
      button.title = `Refresh available in ${cooldownSeconds}s`;
      button.setAttribute("aria-label", `Refresh available in ${cooldownSeconds} seconds`);
      return;
    }

    button.title = "Refresh the zones holding your and your alliance's bases";
    button.setAttribute("aria-label", "Refresh world map");
  }

  startRefreshCooldown() {
    this.refreshCooldownUntil = Date.now() + MAP_REFRESH_COOLDOWN_MS;
    this.clearRefreshCooldownTimer();
    this.updateRefreshButtonState();
    this.refreshCooldownTimer = window.setInterval(() => {
      if (Date.now() >= this.refreshCooldownUntil) {
        this.refreshCooldownUntil = 0;
        this.clearRefreshCooldownTimer();
      }

      this.updateRefreshButtonState();
    }, 1000);
  }

  clearRefreshCooldownTimer() {
    if (!this.refreshCooldownTimer) {
      return;
    }

    window.clearInterval(this.refreshCooldownTimer);
    this.refreshCooldownTimer = 0;
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
    this.toggleToolbarMenu("menu-search");
    if (this.openMenuId === "menu-search") {
      window.setTimeout(() => this.elements.searchInput?.focus(), 30);
      this.renderSearchResults();
    }
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
      const openItem = document.getElementById(this.openMenuId)?.closest(".tb-item");
      if (openItem && !openItem.contains(event.target)) {
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
    if (this.session.token === next) {
      return;
    }
    this.session.token = next;
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
        fetchHiddenPlayers().catch(() => ({ names: [], tileStyle: "blend" })),
        fetchAnnouncement().catch(() => ""),
      ]);

      const isAdmin = Boolean(me?.admin);
      this.isViewerAdmin = isAdmin;
      if (this.renderer) {
        this.renderer.hiddenTileStyle = hidden.tileStyle || "blend";
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
    const valid = ["total", "r1", "r2", "r3", "r4"];
    this.lootResource = valid.includes(key) ? key : "total";
    this.saveUiPref("lootResource", this.lootResource);
    this.applyLootUi();
  }

  // Reflect the loot controls and push the effective state to the renderer.
  // Loot is administrators-only: non-admins never see the Loot menu and never
  // get loot drawn, regardless of their saved preference.
  applyLootUi() {
    const admin = Boolean(this.isViewerAdmin);
    const adminToolsGroup = document.getElementById("admin-tools-group");
    if (adminToolsGroup) {
      // Unhiding the group also draws the "|" separator before Loot.
      adminToolsGroup.hidden = !admin;
    }
    if (this.elements.lootItem) {
      this.elements.lootItem.hidden = !admin;
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
    this.renderer?.setShowLoot(admin && this.showLoot);
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
    item.classList.add("open");
    const button = item.querySelector("[data-menu]") || item.querySelector(".tb-button");
    button?.setAttribute("aria-expanded", "true");
    this.positionToolbarDropdown(menu, button);
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
    menu.style.maxHeight = `${Math.max(180, viewportHeight - top - 12)}px`;
  }

  closeToolbarMenus() {
    if (!this.openMenuId) {
      return;
    }
    const menu = document.getElementById(this.openMenuId);
    const item = menu?.closest(".tb-item");
    item?.classList.remove("open");
    item?.querySelector("[data-menu]")?.setAttribute("aria-expanded", "false");
    this.openMenuId = null;
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
    this.updateRefreshButtonState();
    this.selectedCell = null;
    this.hoveredCell = null;
    this.renderer?.reset(INITIAL_OVERLAY_MESSAGE);
    this.renderDetails();
  }

  setSignedOutState({
    sessionStatus = "Sign in with your own BYM credentials.",
    isError = false,
  } = {}) {
    this.elements.sessionSignedIn.hidden = true;
    this.elements.accountButton.hidden = false;
    this.elements.loginForm.hidden = false;
    this.elements.sessionPanel.classList.remove("signed-in");
    this.elements.loginButton.disabled = false;
    this.elements.sessionName.textContent = "Sign in";
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
    this.setSearchEnabled(false, "Sign in to search the loaded world map.");
    this.setFilterEnabled(false);
    this.setNavEnabled(false);
    this.updateRefreshButtonState();
    this.selectedCell = null;
    this.hoveredCell = null;
    this.isGuestView = false;
    this.viewedWorldId = null;
    this.stopAlliance();
    this.renderer?.reset(SIGNED_OUT_OVERLAY_MESSAGE);
    this.openToolbarMenu("menu-account");
    this.renderDetails();
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
    const attempt = ++this.guestAttemptId;

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
      this.renderer.setOverlay("Please log in. (No cached map data yet.)");
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
      this.elements.worldName.textContent = label ? `${label} (cached)` : "Guest view (cached)";
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
    this.updateRefreshButtonState();
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
    this.elements.jumpStatus.textContent = `Jump to any cell (0-${maxX}, 0-${maxY}); coordinates wrap around the map edges.`;
    const bookmarkHelp = document.getElementById("bookmark-help");
    if (bookmarkHelp) {
      bookmarkHelp.textContent = "Sign in to save bookmarks.";
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
    leave.className = "secondary-button danger alliance-leave";
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

      const row = document.createElement("div");
      row.className = "alliance-roster-row";
      row.appendChild(this.buildAllianceIdentity(member, rank));

      const actions = document.createElement("div");
      actions.className = "alliance-row-actions";
      if (member.main) {
        actions.appendChild(this.buildAllianceButton("Jump", `Jump to ${member.name}'s main yard`,
          () => this.jumpToAllianceYard(member)));
      }
      if (myRank === "leader" && !isSelf) {
        if (rank !== "leader") {
          actions.appendChild(this.buildAllianceButton("\u25b2",
            rank === "officer" ? `Promote ${member.name} to leader (transfers leadership)` : `Promote ${member.name}`,
            () => this.allianceAction("promote", { name: member.name }, status)));
        }
        if (rank !== "recruit" && rank !== "leader") {
          actions.appendChild(this.buildAllianceButton("\u25bc", `Demote ${member.name}`,
            () => this.allianceAction("demote", { name: member.name }, status)));
        }
      } else if (isSelf && myRank === "officer") {
        // Officers may step down on their own.
        actions.appendChild(this.buildAllianceButton("\u25bc", "Step down to Member", () => {
          if (window.confirm("Step down from Officer to Member?")) {
            this.allianceAction("demote", { name: member.name }, status);
          }
        }));
      }
      const canKick = myRankValue >= RANK_VALUE.officer && !isSelf && targetValue < myRankValue;
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

    if (canInvite) {
      const inviteRow = document.createElement("div");
      inviteRow.className = "alliance-form-row";
      const inviteInput = document.createElement("input");
      inviteInput.type = "text";
      inviteInput.maxLength = 80;
      inviteInput.placeholder = "Invite a player by username";
      const inviteButton = document.createElement("button");
      inviteButton.type = "button";
      inviteButton.className = "secondary-button";
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
      inviteRow.append(inviteInput, inviteButton);
      sections.members.appendChild(inviteRow);
    } else {
      const hint = document.createElement("p");
      hint.className = "muted alliance-hint";
      hint.textContent = "Recruits cannot invite players.";
      sections.members.appendChild(hint);
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
      const enemyInput = document.createElement("input");
      enemyInput.type = "text";
      enemyInput.maxLength = 80;
      enemyInput.placeholder = "Mark a player as an enemy";
      const enemyButton = document.createElement("button");
      enemyButton.type = "button";
      enemyButton.className = "secondary-button danger";
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
      enemyRow.append(enemyInput, enemyButton);
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

    const targetList = document.createElement("div");
    targetList.className = "alliance-members alliance-targets";
    const targets = this.alliance.targets || [];
    if (!targets.length) {
      targetList.innerHTML = '<span class="muted">No targets marked yet. Select a cell on the map, then add it here.</span>';
    }
    for (const target of [...targets].reverse()) {
      const row = document.createElement("div");
      row.className = "alliance-roster-row";
      const info = document.createElement("div");
      info.className = "alliance-identity";
      const note = document.createElement("span");
      note.className = "alliance-identity-name";
      note.textContent = target.note || "(no note)";
      note.title = `Added by ${target.addedBy || "?"}`;
      const coords = document.createElement("span");
      coords.className = "alliance-identity-meta";
      coords.textContent = `${target.x}, ${target.y}`;
      const worldTag = document.createElement("span");
      worldTag.className = "alliance-identity-meta";
      worldTag.textContent = this.allianceWorldName(target.world) || "\u2014";
      info.append(note, coords, worldTag);
      row.appendChild(info);
      const actions = document.createElement("div");
      actions.className = "alliance-row-actions";
      actions.appendChild(this.buildAllianceButton("Jump", `Jump to ${target.x}, ${target.y}`,
        () => this.jumpToAllianceYard({ world: target.world, main: { x: target.x, y: target.y } })));
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
    name.className = enemy ? "alliance-identity-name enemy-name" : "alliance-identity-name";
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
    button.className = "secondary-button alliance-row-button";
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
      row.innerHTML =
        `<strong>${escapeHtml(String(event.playerName || ""))}</strong> ${verb} ` +
        `a${/^[aeiou]/i.test(String(event.cellType || "")) ? "n" : ""} ${escapeHtml(String(event.cellType || "base"))} ` +
        `at ${Number(event.x)}, ${Number(event.y)} ${linkWord} ${escapeHtml(String(event.otherParty || "unknown"))}` +
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
      let identity = `<strong>${escapeHtml(from)}</strong>`;
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
  }
}
