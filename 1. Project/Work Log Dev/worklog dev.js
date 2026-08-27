      // ── One-time migration: dev/beta used to share the 'wl2_' keys with
      // production (same GitHub Pages origin). Copy any old shared data into the
      // new 'wl2dev_' namespace once, without touching or deleting the old keys —
      // production keeps reading 'wl2_' untouched.
      (function migrateToDevNamespace() {
        if (localStorage.getItem("wl2dev_migrated")) return;
        const oldKeys = [
          "wl2_archived",
          "wl2_current_theme",
          "wl2_custom_tokens",
          "wl2_custom_type_order",
          "wl2_custom_types",
          "wl2_entries",
          "wl2_gcal_client_id",
          "wl2_gcal_token",
          "wl2_saved_themes",
          "wl2_trash",
          "wl2_type_colors",
          "wl2_type_gcal_ids",
          "wl2_type_order",
        ];
        oldKeys.forEach((oldKey) => {
          const newKey = oldKey.replace("wl2_", "wl2dev_");
          if (localStorage.getItem(newKey) === null) {
            const oldVal = localStorage.getItem(oldKey);
            if (oldVal !== null) localStorage.setItem(newKey, oldVal);
          }
        });
        localStorage.setItem("wl2dev_migrated", "1");
      })();
      // Retro-fix: the original migration list omitted wl2_custom_tokens, so users
      // who already migrated kept a custom theme name with an empty palette. This
      // runs outside the migrated guard and is idempotent.
      if (
        localStorage.getItem("wl2dev_custom_tokens") === null &&
        localStorage.getItem("wl2_custom_tokens") !== null
      ) {
        localStorage.setItem(
          "wl2dev_custom_tokens",
          localStorage.getItem("wl2_custom_tokens"),
        );
      }

      // ── State ──────────────────────────────────────────────────────────────────
      let entries = JSON.parse(localStorage.getItem("wl2dev_entries") || "[]");
      let archived = JSON.parse(
        localStorage.getItem("wl2dev_archived") || "[]",
      );
      let trash = JSON.parse(localStorage.getItem("wl2dev_trash") || "[]");
      // Migration: add updated field to old entries that don't have it
      entries.forEach((e) => {
        if (!e.updated) e.updated = e.created;
      });
      archived.forEach((e) => {
        if (!e.updated) e.updated = e.created;
      });
      // Migration: v1.2.9 bulkDelete briefly wrote 'trashedAt' instead of 'deletedAt'
      trash.forEach((e) => {
        if (!e.deletedAt && e.trashedAt) {
          e.deletedAt = e.trashedAt;
          delete e.trashedAt;
        }
      });
      // Purge trash entries older than 5 days
      (function purgeOldTrash() {
        const cutoff = Date.now() - 5 * 86400000;
        const before = trash.length;
        trash = trash.filter((e) => new Date(e.deletedAt).getTime() > cutoff);
        if (trash.length !== before)
          localStorage.setItem("wl2dev_trash", JSON.stringify(trash));
      })();
      let viewMode = "active"; // 'active' or 'archive'
      let viewLayout = "calendar"; // always start on calendar — list is a per-session choice, never persisted
      let calView = localStorage.getItem("wl2dev_cal_view") || "month"; // 'month' or 'year'
      let calYear = new Date().getFullYear();
      let calMonth = new Date().getMonth(); // 0-11, displayed calendar month
      let calEntryId = null; // entry shown in the calendar popover
      let calArchIdSet = new Set(); // archived entry ids currently shown in the month grid
      let searchQuery = "";
      let gcalToken = localStorage.getItem("wl2dev_gcal_token") || null;
      let gcalClientId = localStorage.getItem("wl2dev_gcal_client_id") || "";
      let selectedFilterTypes = []; // empty = All
      let sortMode = "deadline";
      let sortDir = "desc"; // deadline default: furthest first
      let pinnedId = null; // newly added entry shown at top until sort changes
      let editingId = null;
      let syncMode = "event"; // 'event' or 'task'

      // ── Settings state ─────────────────────────────────────────────────────────
      const BUILTIN_TYPES = [
        "Meeting",
        "Review",
        "Report",
        "Research",
        "Other",
      ];

      function fmtTime12(t) {
        if (!t) return "";
        const [h, m] = t.split(":");
        const hr = parseInt(h);
        return (hr % 12 || 12) + ":" + m + " " + (hr < 12 ? "AM" : "PM");
      }

      function buildGTaskTitle(entry) {
        return entry.time
          ? `${fmtTime12(entry.time)} | ${entry.name}`
          : entry.name;
      }
      let customTypes = JSON.parse(
        localStorage.getItem("wl2dev_custom_types") || "[]",
      );
      let customTypeOrder = JSON.parse(
        localStorage.getItem("wl2dev_custom_type_order") || "[]",
      );
      let typeOrder = JSON.parse(
        localStorage.getItem("wl2dev_type_order") || "[]",
      );
      let typeColors = JSON.parse(
        localStorage.getItem("wl2dev_type_colors") || "{}",
      );
      let typeGCalIds = JSON.parse(
        localStorage.getItem("wl2dev_type_gcal_ids") || "{}",
      );

      function allTypes() {
        if (typeOrder.length > 0) {
          // Use the custom type order if it exists
          return typeOrder
            .filter((t) => BUILTIN_TYPES.includes(t) || customTypes.includes(t))
            .concat(BUILTIN_TYPES.filter((t) => !typeOrder.includes(t)))
            .concat(customTypes.filter((t) => !typeOrder.includes(t)));
        }
        // Fallback to original order
        const builtins = [...BUILTIN_TYPES];
        const customs =
          customTypeOrder.length > 0
            ? customTypeOrder
                .filter((t) => customTypes.includes(t))
                .concat(customTypes.filter((t) => !customTypeOrder.includes(t)))
            : [...customTypes];
        return [...builtins, ...customs];
      }

      // ── OAuth token auto-capture ───────────────────────────────────────────────
      // Cross-window OAuth relay tag. NOT a localStorage key — do not rename this
      // per-environment. The OAuth popup's redirect_uri is hardcoded to the
      // production URL (see gcalAuthorise), so the popup always runs PRODUCTION's
      // deployed code, which always sends this exact string. If this ever diverges
      // from production's copy, "Connect Google Calendar" silently breaks here.
      const GCAL_OAUTH_MESSAGE_TYPE = "wl2_gcal_token";

      // If this page load is the OAuth popup (URL has #access_token=...), grab the
      // token, hand it back to the window that opened us, then close.
      (function captureOAuthRedirect() {
        if (location.hash && location.hash.indexOf("access_token=") !== -1) {
          const params = new URLSearchParams(location.hash.slice(1));
          const token = params.get("access_token");
          if (token && window.opener) {
            try {
              window.opener.postMessage(
                { type: GCAL_OAUTH_MESSAGE_TYPE, token },
                location.origin,
              );
            } catch (e) {}
            // Clean the token out of the address bar then close the popup.
            history.replaceState(null, "", location.pathname + location.search);
            window.close();
          }
        }
      })();

      // Main-window listener: receive the token the popup sent and connect.
      window.addEventListener("message", function (ev) {
        if (ev.origin !== location.origin) return;
        if (
          ev.data &&
          ev.data.type === GCAL_OAUTH_MESSAGE_TYPE &&
          ev.data.token
        ) {
          gcalApplyToken(ev.data.token);
        }
      });

      // Audit fix: icon-only buttons had a `title` tooltip but no accessible name
      // (title isn't reliably read by screen readers and never appears on touch),
      // and their decorative SVGs weren't hidden from assistive tech. Buttons are
      // generated throughout the app (entry cards, calendar, modals) via innerHTML,
      // so a one-time pass can't catch them all — a MutationObserver mirrors
      // title→aria-label and hides icon SVGs as new DOM appears, everywhere.
      function a11yFixIconButtons(root) {
        root
          .querySelectorAll(
            ".icon-btn[title]:not([aria-label]), .cal-nav-btn[title]:not([aria-label])",
          )
          .forEach((btn) => {
            btn.setAttribute("aria-label", btn.getAttribute("title"));
          });
        root.querySelectorAll("svg.icon:not([aria-hidden])").forEach((svg) => {
          svg.setAttribute("aria-hidden", "true");
        });
      }
      // Coalesce a burst of mutations (one render() = many) into a single scan
      // per animation frame, and scan only the subtrees that actually changed.
      let a11yPending = null;
      new MutationObserver((muts) => {
        if (!a11yPending) a11yPending = new Set();
        for (const m of muts)
          if (m.addedNodes.length) {
            a11yPending.add(m.target);
            for (const n of m.addedNodes)
              if (n.nodeType === 1) enhanceDateInputs(n);
          }
        if (a11yPending.size && !a11yFixIconButtons._raf)
          a11yFixIconButtons._raf = requestAnimationFrame(() => {
            a11yFixIconButtons._raf = 0;
            const roots = a11yPending;
            a11yPending = null;
            roots.forEach((r) => r.isConnected && a11yFixIconButtons(r));
          });
      }).observe(document.body, { childList: true, subtree: true });

      // ── Date field (typed dd/mm/yyyy + native picker) ──────────────────────
      // Every <input type="date"> is wrapped: a plain text box takes the typing
      // (slashes auto-inserted forward, backspace flows straight through — the
      // native control traps backspace inside one segment), and a calendar
      // button opens the browser's own picker via showPicker(). The original
      // input stays in the DOM (invisible) so getElementById()/.value keep
      // working; its `value` property is patched so programmatic sets refresh
      // the visible text.
      const DATE_VALUE_DESC = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      );
      function dateIsoToText(iso) {
        const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || "");
        return m ? `${m[3]}/${m[2]}/${m[1]}` : "";
      }
      function dateTextToIso(txt) {
        const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec((txt || "").trim());
        if (!m) return null;
        const d = +m[1],
          mo = +m[2],
          y = +m[3];
        if (mo < 1 || mo > 12 || d < 1 || y < 1900) return null;
        const dt = new Date(y, mo - 1, d);
        if (dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null;
        return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      }
      function enhanceDateInput(input) {
        if (input.dataset.dateField || !input.isConnected) return;
        input.dataset.dateField = "1";
        const wrap = document.createElement("div");
        wrap.className = "date-field";
        wrap.style.cssText = input.style.cssText; // inherit inline width/flex
        input.style.cssText = "";
        if (input.title) wrap.title = input.title;

        // Three locked segments — day / month / year — like the native control:
        // click one and it is selected whole, typing overwrites it and hops on
        // when full, Backspace clears the whole block (empty block → hops back).
        // Empty blocks show their grey placeholder and never shift position.
        const box = document.createElement("div");
        box.className = "date-field-box";
        box.setAttribute("role", "group");
        // Field context for screen readers: explicit aria-label wins, else the
        // nearest .field-label in the same form group, else the input's own id.
        const ctxLabel =
          input.getAttribute("aria-label") ||
          (
            input.closest(".form-group")?.querySelector(".field-label")
              ?.textContent || ""
          ).trim() ||
          (input.labels && input.labels[0]?.textContent.trim()) ||
          "Date";
        box.setAttribute("aria-label", ctxLabel);
        const SEGS = [
          { ph: "dd", max: 2, min: 1, hi: 31 },
          { ph: "mm", max: 2, min: 1, hi: 12 },
          { ph: "yyyy", max: 4, min: 1900, hi: 9999 },
        ];
        const segs = SEGS.map((s, i) => {
          const el = document.createElement("input");
          el.type = "text";
          el.className = "date-seg date-seg-" + s.ph;
          el.placeholder = s.ph;
          el.inputMode = "numeric";
          el.autocomplete = "off";
          el.maxLength = s.max;
          el.setAttribute(
            "aria-label",
            ctxLabel + ", " + ["Day", "Month", "Year"][i],
          );
          if (i) {
            const sep = document.createElement("span");
            sep.className = "date-sep";
            sep.textContent = "/";
            sep.setAttribute("aria-hidden", "true");
            box.appendChild(sep);
          }
          box.appendChild(el);
          return el;
        });

        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "date-field-btn";
        btn.title = "Open calendar";
        btn.setAttribute("aria-label", "Open calendar");
        // Keyboard: segments are the primary control; the picker button stays
        // reachable, the invisible native input is skipped.
        btn.tabIndex = 0;
        input.tabIndex = -1;
        input.setAttribute("aria-hidden", "true");
        btn.innerHTML =
          '<svg class="icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>';

        input.parentNode.insertBefore(wrap, input);
        wrap.appendChild(box);
        wrap.appendChild(btn);
        wrap.appendChild(input);

        const showIso = (iso) => {
          const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || "");
          segs[0].value = m ? m[3] : "";
          segs[1].value = m ? m[2] : "";
          segs[2].value = m ? m[1] : "";
          wrap.classList.remove("invalid");
        };
        const readIso = () =>
          dateTextToIso(`${segs[0].value}/${segs[1].value}/${segs[2].value}`);
        showIso(DATE_VALUE_DESC.get.call(input));

        let committing = false;
        const commit = (iso, fire) => {
          DATE_VALUE_DESC.set.call(input, iso || "");
          if (fire) {
            committing = true;
            input.dispatchEvent(new Event("input", { bubbles: true }));
            input.dispatchEvent(new Event("change", { bubbles: true }));
            committing = false;
          }
        };
        // Any segment change: full valid date → commit; otherwise the date is
        // "not set yet" (partial), so clear the underlying value.
        const sync = () => {
          wrap.classList.remove("invalid");
          const iso = readIso();
          if (iso) commit(iso, true);
          else if (DATE_VALUE_DESC.get.call(input)) commit("", true);
        };

        Object.defineProperty(input, "value", {
          configurable: true,
          get() {
            return DATE_VALUE_DESC.get.call(this);
          },
          set(v) {
            DATE_VALUE_DESC.set.call(this, v);
            showIso(DATE_VALUE_DESC.get.call(this));
          },
        });

        const focusSeg = (i) => {
          const el = segs[i];
          if (!el) return;
          el.focus();
          el.select();
        };
        segs.forEach((el, i) => {
          const spec = SEGS[i];
          el.addEventListener("focus", () => el.select());
          el.addEventListener("mousedown", (e) => {
            e.preventDefault(); // no caret placement — the whole block is the unit
            focusSeg(i);
          });
          el.addEventListener("keydown", (e) => {
            if (e.key === "Backspace" && el.value === "" && i > 0) {
              e.preventDefault();
              focusSeg(i - 1);
            } else if (e.key === "Backspace" && el.value !== "") {
              e.preventDefault(); // block delete, whatever the caret/selection
              el.value = "";
              sync();
            } else if (
              e.key === "ArrowLeft" &&
              i > 0 &&
              el.selectionStart === 0
            ) {
              e.preventDefault();
              focusSeg(i - 1);
            } else if (
              e.key === "ArrowRight" &&
              i < 2 &&
              el.selectionEnd === el.value.length
            ) {
              e.preventDefault();
              focusSeg(i + 1);
            } else if (e.key === "/" || e.key === "-" || e.key === ".") {
              e.preventDefault();
              if (el.value && i < 2) focusSeg(i + 1);
            }
          });
          el.addEventListener("input", () => {
            let v = el.value.replace(/\D/g, "").slice(0, spec.max);
            el.value = v;
            sync();
            // Hop on when the block is full, or when the next digit could not
            // possibly still belong to this block (e.g. day 4 → "04").
            const n = parseInt(v || "0", 10);
            const full = v.length === spec.max;
            const noRoom = i < 2 && v.length === 1 && n * 10 > spec.hi;
            if ((full || noRoom) && i < 2) {
              if (noRoom) {
                el.value = v.padStart(2, "0");
                sync();
              }
              focusSeg(i + 1);
            }
          });
          el.addEventListener("blur", () => {
            // Pad 5 → 05 / 26 → 2026-style completion is intentionally NOT
            // done for the year; days/months get zero-padded.
            if (i < 2 && el.value.length === 1) el.value = "0" + el.value;
            const anyFilled = segs.some((s) => s.value);
            const allFilled = segs.every((s) => s.value);
            if (anyFilled && !allFilled) return; // still typing elsewhere
            sync();
            if (allFilled && !readIso()) wrap.classList.add("invalid");
          });
        });

        // Picker result (or any native change) → mirror into the segments
        input.addEventListener("change", () => {
          if (committing) return;
          showIso(DATE_VALUE_DESC.get.call(input));
        });
        box.addEventListener("click", (e) => {
          if (e.target === box) focusSeg(0);
        });
        btn.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          try {
            input.showPicker();
          } catch (_) {
            input.focus();
            input.click();
          }
        });
      }
      function enhanceDateInputs(root) {
        (root.querySelectorAll ? root : document)
          .querySelectorAll('input[type="date"]:not([data-date-field])')
          .forEach(enhanceDateInput);
      }

      // ── Init ───────────────────────────────────────────────────────────────────
      // NOTE: init() is invoked at the very END of the script (see bottom of file),
      // after ALL let/const state declarations, so nothing is accessed in its TDZ.
      function init() {
        a11yFixIconButtons(document.body);
        // Every overlay is a dialog to assistive tech; label it from its heading.
        document
          .querySelectorAll(
            ".modal-overlay, .settings-overlay, .trash-overlay, .due-modal-overlay",
          )
          .forEach((ov) => {
            ov.setAttribute("role", "dialog");
            ov.setAttribute("aria-modal", "true");
            const h = ov.querySelector("h1,h2,h3,.modal-title,.settings-title");
            if (h) {
              if (!h.id) h.id = ov.id + "-title";
              ov.setAttribute("aria-labelledby", h.id);
            }
          });
        document.getElementById("f-deadline").value = today();
        document.getElementById("f-deadline-task").value = today();
        // Sync sort direction button icon to default asc
        const sdBtn = document.getElementById("sort-dir-btn");
        if (sdBtn) {
          sdBtn.title = "Currently ascending — click for descending";
          sdBtn.innerHTML = `<svg class="icon sm" viewBox="0 0 24 24"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>`;
        }
        if (gcalToken) {
          document.getElementById("gcal-pill").classList.add("connected");
          document.getElementById("gcal-pill-text").textContent =
            "Calendar connected";
          // Verify the stored token is actually live, then pull/push cross-device sync
          verifyGCalToken().then(() => {
            if (!gcalExpired) {
              performSync();
              fetchGCalColors();
            }
          });
        }
        populateTypeSelects();
        render();
        updateTrashBadge();
        checkDueOverdue();
        initializeTimePickers();
        enhanceDateInputs(document);
      }

      function initializeTimePickers() {
        ["f-time", "f-time-to"].forEach((id) => {
          try {
            const input = document.getElementById(id);
            if (!input) return;
            const parent = input.parentElement;
            const next = input.nextSibling;
            const picker = createTimePicker(id);
            if (next) parent.insertBefore(picker, next);
            else parent.appendChild(picker);
          } catch (err) {
            console.error("initializeTimePickers error for", id, err);
          }
        });
      }

      function initializeEditTimePickers(entryId) {
        [`edit-time-${entryId}`, `edit-time-to-${entryId}`].forEach((id) => {
          const input = document.getElementById(id);
          if (!input) return;
          const parent = input.parentElement;
          const next = input.nextSibling;
          const picker = createTimePicker(id);
          if (next) parent.insertBefore(picker, next);
          else parent.appendChild(picker);
        });
      }

      // Mobile-only (≤700px): the sidebar form hides behind a floating + button
      // and slides in as a full-screen overlay. No-ops on desktop, where the
      // .mobile-open class has no effect (sidebar isn't position:fixed there).
      function openMobileSidebar() {
        document.getElementById("sidebar").classList.add("mobile-open");
        document.body.classList.add("no-scroll");
        document.getElementById("f-name")?.focus();
      }
      function closeMobileSidebar() {
        document.getElementById("sidebar").classList.remove("mobile-open");
        document.body.classList.remove("no-scroll");
      }

      function setSyncMode(mode) {
        syncMode = mode;
        document
          .getElementById("mode-event-btn")
          .classList.toggle("active", mode === "event");
        document
          .getElementById("mode-task-btn")
          .classList.toggle("active", mode === "task");
        document.getElementById("f-deadline-range").style.display =
          mode === "event" ? "grid" : "none";
        document.getElementById("f-deadline-single").style.display =
          mode === "task" ? "block" : "none";
        document.getElementById("f-deadline-label").textContent =
          mode === "task" ? "Due date" : "Deadline";
      }

      // Toggle Event/Task inside an open edit card. Only flips the form; the real
      // mode change (and any GCal/GTasks cleanup) happens on Save.
      function setEditSyncMode(id, mode) {
        const hidden = document.getElementById("edit-syncmode-" + id);
        if (hidden) hidden.value = mode;
        document
          .getElementById("edit-mode-event-" + id)
          ?.classList.toggle("active", mode === "event");
        document
          .getElementById("edit-mode-task-" + id)
          ?.classList.toggle("active", mode === "task");
        const taskBlock = document.getElementById("edit-dates-task-" + id);
        const eventBlock = document.getElementById("edit-dates-event-" + id);
        if (taskBlock)
          taskBlock.style.display = mode === "task" ? "block" : "none";
        if (eventBlock)
          eventBlock.style.display = mode === "task" ? "none" : "contents";
        const note = document.getElementById("edit-time-label-note-" + id);
        if (note)
          note.textContent = mode === "task" ? " (shown in task title)" : "";
        // Keep the two date inputs in step so switching modes doesn't silently
        // change the date to a stale value from the other input.
        const evDate = document.getElementById("edit-deadline-" + id);
        const taskDate = document.getElementById("edit-deadline-task-" + id);
        if (evDate && taskDate) {
          if (mode === "task") taskDate.value = evDate.value || taskDate.value;
          else evDate.value = taskDate.value || evDate.value;
        }
      }

      // LOCAL date, not UTC — toISOString() marked the previous day as "today"
      // until 07:00 in GMT+7, mis-circling the calendar and mis-defaulting dates.
      function today() {
        const d = new Date();
        return (
          d.getFullYear() +
          "-" +
          String(d.getMonth() + 1).padStart(2, "0") +
          "-" +
          String(d.getDate()).padStart(2, "0")
        );
      }

      // ── CRUD ───────────────────────────────────────────────────────────────────
      function addEntry() {
        const name = v("f-name");
        const type = v("f-type");
        const remark = v("f-remark");
        if (!name) {
          fieldError("f-name", "Enter a work name.");
          return;
        }
        const time = v("f-time");
        const timeTo = v("f-time-to");
        const isTask = syncMode === "task";
        const deadline = isTask ? v("f-deadline-task") : v("f-deadline");
        const deadlineEnd = isTask ? "" : v("f-deadline-end");
        if (deadlineEnd && deadline && deadlineEnd < deadline) {
          fieldError(
            "f-deadline-end",
            "End date can't be before the start date.",
          );
          return;
        }
        const color = typeColors[type] || null;
        const gcalColorId = typeGCalIds[type] || undefined;
        const now = new Date().toISOString();
        const entry = {
          id: Date.now(),
          name,
          type,
          deadline,
          deadlineEnd,
          time,
          timeTo,
          remark,
          color,
          gcalColorId,
          syncMode: isTask ? "task" : "event",
          createdAt: now,
          updatedAt: now,
        };

        // If repeat is checked, show confirm modal instead of adding directly
        if (document.getElementById("f-repeat")?.checked) {
          if (!deadline) {
            toast("Set a start date before repeating.");
            return;
          }
          const dates = generateRepeatDates(deadline);
          if (!dates) return;
          if (!dates.length) {
            toast(
              "No dates generated — check your end date and repeat settings.",
            );
            return;
          }
          // Add the original entry first, then open modal for repeats
          entries.unshift(entry);
          pinnedId = entry.id;
          save();
          render();
          if (gcalToken && deadline) {
            isTask ? pushToGTask(entry, true) : pushToGCal(entry, true);
          }
          openRepeatModal(entry, dates);
          return;
        }

        commitNewEntry(entry);
        clearForm();
        closeMobileSidebar(); // narrow screens: return to the list/calendar after adding
      }

      // Shared add path: pushes a fully-built entry into the list, persists,
      // renders, and mirrors to Google. Used by the sidebar form (addEntry) and the
      // calendar quick-add modal — which must NOT touch the sidebar form's fields.
      function commitNewEntry(entry) {
        entries.unshift(entry);
        pinnedId = entry.id;
        save();
        render();
        toast("Entry added.");
        // In calendar month view the page itself can't scroll (body.cal-fit pins
        // it to 100vh) — only the inner grid does, easy to miss on a narrow/short
        // window, and a busy day can cap the new entry into "+N more" with no chip
        // ever rendered to scroll to. Pop the day's full list open instead, which
        // always shows the true set and is a fixed-position modal either way.
        // Only when the calendar is actually on screen (not the Archive list, which
        // keeps viewLayout='calendar' but renders a list) and the new entry passes
        // the active filter/search — otherwise the popup would say "Nothing on
        // this day" right after "Entry added".
        const visibleInCal =
          viewMode === "active" &&
          (selectedFilterTypes.length === 0 ||
            selectedFilterTypes.includes(entry.type)) &&
          matchesSearch(entry, searchQuery);
        if (
          viewLayout === "calendar" &&
          calView === "month" &&
          entry.deadline &&
          visibleInCal
        ) {
          openCalDay(entry.deadline);
        }
        if (gcalToken && entry.deadline) {
          if (entry.syncMode === "task") pushToGTask(entry);
          else pushToGCal(entry);
        }
        return entry;
      }

      // Pending trash action shown in the confirmation modal: {kind:'single', id}
      // or {kind:'bulk'}. Cleared on Cancel / Esc / backdrop click.
      let trashPending = null;
      function openTrashConfirm(pending, bodyText) {
        trashPending = pending;
        document.getElementById("trash-confirm-body").innerHTML = bodyText;
        document.getElementById("trash-confirm-modal").classList.add("open");
      }
      function closeTrashConfirm() {
        trashPending = null;
        document.getElementById("trash-confirm-modal").classList.remove("open");
      }
      function trashConfirmOk() {
        const p = trashPending;
        closeTrashConfirm();
        if (!p) return;
        if (p.kind === "single") deleteEntry(p.id, true);
        else if (p.kind === "bulk") bulkDelete(true);
      }
      document
        .getElementById("trash-confirm-modal")
        ?.addEventListener("click", (ev) => {
          if (ev.target.id === "trash-confirm-modal") closeTrashConfirm();
        });

      function deleteEntry(id, confirmed) {
        const entry = entries.find((e) => e.id === id);
        if (!entry) return;
        if (!confirmed) {
          openTrashConfirm(
            { kind: "single", id },
            `<b>${esc(entry.name)}</b> will be moved to Trash.`,
          );
          return;
        }
        if (gcalToken)
          entry.syncMode === "task"
            ? deleteFromGTask(entry)
            : deleteFromGCal(entry);
        entry.deletedAt = new Date().toISOString();
        trash.unshift(entry);
        entries = entries.filter((e) => e.id !== id);
        saveTrash();
        save();
        render();
        updateTrashBadge();
        toastWithUndo(`Moved "${entry.name}" to Trash.`, () =>
          restoreFromTrash(id),
        );
      }

      function restoreFromTrash(id) {
        const e = trash.find((x) => x.id === id);
        if (!e) return;
        delete e.deletedAt;
        // Bump the timestamp so cross-device sync sees the restore as the newest
        // state — otherwise the remote trash copy (with deletedAt) wins the merge
        // and silently re-trashes the entry.
        touchEntry(e);
        entries.unshift(e);
        trash = trash.filter((x) => x.id !== id);
        saveTrash();
        save();
        render();
        renderTrash();
        updateTrashBadge();
        toast("Entry restored to active.");
      }

      function clearTrash() {
        if (!trash.length) return;
        const count = trash.length;
        if (
          !confirm(
            `Permanently delete ${count} ${count === 1 ? "entry" : "entries"} from Trash? This cannot be undone.`,
          )
        )
          return;
        addTombstones(trash.map((e) => e.id));
        trash = [];
        saveTrash();
        renderTrash();
        updateTrashBadge();
        scheduleSync();
        toast(
          `Trash cleared — ${count} ${count === 1 ? "entry" : "entries"} permanently deleted.`,
        );
      }

      function openTrash() {
        renderTrash();
        document.getElementById("trash-overlay").classList.add("open");
      }
      function closeTrash() {
        document.getElementById("trash-overlay").classList.remove("open");
      }

      function updateTrashBadge() {
        const b = document.getElementById("trash-badge");
        if (b) b.textContent = trash.length ? `(${trash.length})` : "";
      }

      function renderTrash() {
        const body = document.getElementById("trash-body");
        const countEl = document.getElementById("trash-count");
        const clearBtn = document.getElementById("trash-clear-btn");
        updateTrashBadge();
        if (clearBtn) clearBtn.style.display = trash.length ? "" : "none";
        if (!trash.length) {
          body.innerHTML =
            '<div class="empty-state"><div class="empty-icon">🗑️</div><p>Trash is empty.</p></div>';
          if (countEl) countEl.textContent = "";
          return;
        }
        if (countEl)
          countEl.textContent = `${trash.length} item${trash.length !== 1 ? "s" : ""}`;
        const now = Date.now();
        body.innerHTML = trash
          .map((e) => {
            const deletedMs = new Date(e.deletedAt).getTime();
            const daysLeft = Math.max(
              1,
              Math.ceil((deletedMs + 5 * 86400000 - now) / 86400000),
            );
            const typeChip = e.type
              ? `<span class="chip type" style="font-size:10px;">${esc(e.type)}</span>`
              : "";
            return `<div class="trash-item">
      <div class="trash-item-body">
        <div class="trash-item-name">${esc(e.name)}</div>
        <div style="display:flex;gap:8px;align-items:center;margin-top:4px;flex-wrap:wrap;">
          ${typeChip}
          <span style="font-size:12px;color:var(--text3);">Deleted ${e.deletedAt ? fmtDate(e.deletedAt.split("T")[0]) : "—"}</span>
          <span style="font-size:12px;color:var(--danger);">· ${daysLeft} day${daysLeft !== 1 ? "s" : ""} remaining</span>
        </div>
      </div>
      <button class="btn btn-sm" onclick="restoreFromTrash(${e.id})" style="flex-shrink:0;gap:4px;">${restoreIcon()} Restore</button>
    </div>`;
          })
          .join("");
      }

      function startEdit(id) {
        editingId = id;
        render();
        setTimeout(() => {
          const el = document.getElementById("edit-name-" + id);
          if (el) el.focus();
        }, 50);
      }

      function cancelEdit() {
        editingId = null;
        render();
      }

      let saveEditInFlight = false;
      async function saveEdit(id) {
        // Re-entry guard: a double-click during the network verify below would
        // otherwise pass both calls through and create two Google objects.
        if (saveEditInFlight) return false;
        const e0 = entries.find((x) => x.id === id);
        if (!e0) return false;
        const name = v("edit-name-" + id);
        if (!name) {
          fieldError("edit-name-" + id, "Name cannot be empty.");
          return false;
        }
        const newMode = v("edit-syncmode-" + id) === "task" ? "task" : "event";
        const modeChanged =
          newMode !== (e0.syncMode === "task" ? "task" : "event");
        // Snapshot every field NOW. After the await the edit form may be gone
        // (Cancel, a sync-driven re-render, a view toggle) and v() would return ''.
        const snap = {
          type: v("edit-type-" + id),
          time: v("edit-time-" + id),
          timeTo: v("edit-time-to-" + id),
          remark: v("edit-remark-" + id),
          deadline:
            newMode === "task"
              ? v("edit-deadline-task-" + id)
              : v("edit-deadline-" + id),
          deadlineEnd: newMode === "task" ? "" : v("edit-deadline-end-" + id),
        };
        if (
          snap.deadlineEnd &&
          snap.deadline &&
          snap.deadlineEnd < snap.deadline
        ) {
          fieldError(
            "edit-deadline-end-" + id,
            "End date can't be before the start date.",
          );
          return false;
        }
        // Switching mode on an already-synced entry needs a LIVE Google connection
        // to clean up the old copy — a stored token may have expired hours ago, so
        // verify it now rather than trusting its presence. Disconnected or expired:
        // warn and abort the save (edit stays open).
        if (modeChanged && (e0.gcalEventId || e0.gcalTaskId)) {
          let liveStatus = "disconnected";
          saveEditInFlight = true;
          try {
            if (gcalToken && !gcalExpired) liveStatus = await verifyGCalToken();
          } finally {
            saveEditInFlight = false;
          }
          // Fail closed: offline ('network') counts as no live connection too —
          // proceeding would silently orphan the old copy on Google.
          if (!gcalToken || gcalExpired || liveStatus !== "ok") {
            document
              .getElementById("mode-switch-warn-modal")
              .classList.add("open");
            return false;
          }
        }
        // Re-resolve: a merge during the await may have swapped the object.
        const e = entries.find((x) => x.id === id);
        if (!e) return false;
        e.name = name;
        e.type = snap.type;
        e.time = snap.time;
        e.timeTo = snap.timeTo;
        e.remark = snap.remark;
        e.color = typeColors[e.type] || e.color || null;
        e.gcalColorId = typeGCalIds[e.type] || undefined;
        e.syncMode = newMode;
        e.deadline = snap.deadline;
        e.deadlineEnd = snap.deadlineEnd;
        touchEntry(e);
        editingId = null;
        if (modeChanged) {
          // Remove the old-mode object on Google's side (if connected), then create
          // fresh as the new mode. Stale ids are cleared either way so a later
          // connect never PATCHes the wrong kind of object.
          if (gcalToken && e.gcalEventId) deleteFromGCal(e, true);
          if (gcalToken && e.gcalTaskId) deleteFromGTask(e, true);
          e.gcalEventId = null;
          e.gcalTaskId = null;
        }
        save();
        render();
        toast("Entry updated.");
        if (gcalToken && e.deadline) {
          if (modeChanged) {
            newMode === "task" ? pushToGTask(e) : pushToGCal(e);
          } else if (e.syncMode === "task" && e.gcalTaskId) patchGTask(e);
          else if (e.syncMode !== "task" && e.gcalEventId) patchGCal(e);
        }
        return true;
      }

      function save() {
        localStorage.setItem("wl2dev_entries", JSON.stringify(entries));
        localStorage.setItem("wl2dev_archived", JSON.stringify(archived));
        syncDirty = true;
        scheduleSync();
      }
      function saveTrash() {
        localStorage.setItem("wl2dev_trash", JSON.stringify(trash));
        syncDirty = true;
      }
      // Persist all lists WITHOUT marking data dirty or scheduling a sync — for the
      // merge itself, whose writes must never re-arm the next sync (that was the
      // v1.6.17-26 infinite 4-second sync loop).
      function persistMerged() {
        localStorage.setItem("wl2dev_entries", JSON.stringify(entries));
        localStorage.setItem("wl2dev_archived", JSON.stringify(archived));
        localStorage.setItem("wl2dev_trash", JSON.stringify(trash));
        saveTombstones();
      }

      function archiveEntry(id) {
        const e = entries.find((x) => x.id === id);
        if (!e) return;
        e.archivedAt = new Date().toISOString();
        archived.unshift(e);
        entries = entries.filter((x) => x.id !== id);
        save();
        render();
        toast("Entry archived. View it in Archive.");
      }

      function restoreEntry(id) {
        const e = archived.find((x) => x.id === id);
        if (!e) return;
        delete e.archivedAt;
        if (e.syncMode === "task") e.completed = false;
        // Same sync rule as restoreFromTrash: newest timestamp must be the restore.
        touchEntry(e);
        entries.unshift(e);
        archived = archived.filter((x) => x.id !== id);
        save();
        render();
        toast("Entry restored to active.");
        if (e.syncMode === "task" && gcalToken && e.gcalTaskId)
          patchGTask(e, true);
      }

      function deleteArchived(id) {
        if (!confirm("Permanently delete this entry? This cannot be undone."))
          return;
        const entry = archived.find((x) => x.id === id);
        if (entry)
          entry.syncMode === "task"
            ? deleteFromGTask(entry)
            : deleteFromGCal(entry);
        archived = archived.filter((x) => x.id !== id);
        addTombstones([id]);
        save();
        render();
        toast("Entry permanently deleted.");
      }
      // ── Due / Overdue Alert Modal ──────────────────────────────────────────────
      function checkDueOverdue() {
        const t = today();
        const flagged = entries.filter((e) => {
          if (!e.deadline) return false;
          const status = deadlineStatus(e.deadline, e.deadlineEnd);
          return (
            status === " overdue" ||
            status === " today" ||
            status === " last-day" ||
            status === " in-progress"
          );
        });
        if (!flagged.length) return;

        const list = document.getElementById("due-modal-list");
        list.innerHTML = flagged
          .map((e) => {
            const status = deadlineStatus(e.deadline, e.deadlineEnd);
            const isMultiDay = e.deadlineEnd && e.deadlineEnd !== e.deadline;
            const dateRange = isMultiDay
              ? `${fmtDate(e.deadline)} → ${fmtDate(e.deadlineEnd)}`
              : fmtDate(e.deadline);
            let cssClass, label;
            if (status === " overdue") {
              cssClass = "overdue";
              label = `Overdue · ${dateRange}`;
            } else if (status === " today") {
              cssClass = "today";
              label = "Due today";
            } else if (status === " last-day") {
              cssClass = "today";
              label = `Last day · ${dateRange}`;
            } else {
              cssClass = "in-progress";
              label = `In Progress · ${dateRange}`;
            }
            const cardColor = typeColors[e.type] || null;
            const typeChip = e.type
              ? (() => {
                  const dot = cardColor
                    ? `<span style="width:7px;height:7px;border-radius:50%;background:${esc(cardColor)};display:inline-block;margin-right:3px;flex-shrink:0;vertical-align:middle;"></span>`
                    : "";
                  const chipStyle = cardColor
                    ? ` style="background:${esc(cardColor)}22;color:${esc(cardColor)};border-color:${esc(cardColor)}55;"`
                    : "";
                  return `<span class="chip type"${chipStyle}>${dot}${esc(e.type)}</span>`;
                })()
              : "";
            return `
    <div class="due-item ${cssClass}" id="due-item-${e.id}">
      <div class="due-item-name">${esc(e.name)}</div>
      <div class="due-item-meta">${typeChip}<span>${label}</span></div>
      <div class="due-item-actions">
        <button class="btn btn-sm btn-danger" onclick="dueArchive(${e.id})">Archive</button>
        <input type="date" id="due-extend-${e.id}" value="${t}" min="${t}" style="width:140px;"/>
        <button class="btn btn-sm" onclick="dueExtend(${e.id})">Extend to date</button>
      </div>
    </div>`;
          })
          .join("");

        document.getElementById("due-modal").classList.add("open");
      }

      function closeDueModal() {
        document.getElementById("due-modal").classList.remove("open");
      }

      function dueArchive(id) {
        archiveEntry(id);
        const el = document.getElementById("due-item-" + id);
        if (el) el.remove();
        if (!document.getElementById("due-modal-list").children.length)
          closeDueModal();
      }

      function dueExtend(id) {
        const newDate = document.getElementById("due-extend-" + id)?.value;
        if (!newDate) {
          toast("Pick a date first.");
          return;
        }
        const e = entries.find((x) => x.id === id);
        if (!e) return;
        e.deadline = newDate;
        touchEntry(e);
        if (e.syncMode === "task" && e.gcalTaskId && gcalToken) patchGTask(e);
        else if (e.syncMode !== "task" && e.gcalEventId && gcalToken)
          patchGCal(e);
        save();
        render();
        toast("Deadline extended to " + fmtDate(newDate) + ".");
        const el = document.getElementById("due-item-" + id);
        if (el) el.remove();
        if (!document.getElementById("due-modal-list").children.length)
          closeDueModal();
      }

      function v(id) {
        return document.getElementById(id)?.value.trim() || "";
      }

      // Single place that stamps an entry as "just changed". Writes BOTH legacy
      // field names so every consumer (sync's entryTs, exports, old readers) agrees;
      // cross-device sync resolves conflicts by newest stamp, so every mutation of
      // an entry MUST call this or the change loses merge ties and never propagates.
      function touchEntry(e) {
        const now = new Date().toISOString();
        e.updatedAt = now;
        e.updated = now;
        return e;
      }

      // ── Time Picker ───────────────────────────────────────────────────────────────
      function createTimePicker(inputId) {
        const input = document.getElementById(inputId);
        const wrapper = document.createElement("div");
        wrapper.className = "time-picker-wrapper";

        const trigger = document.createElement("input");
        trigger.type = "text";
        trigger.className = "time-picker-trigger";
        trigger.placeholder = input.placeholder || "HH:MM";
        trigger.readOnly = false;
        trigger.inputMode = "numeric";
        trigger.value = input.value || "";

        const modal = document.createElement("div");
        modal.className = "time-picker-modal";

        const hCol = document.createElement("div");
        hCol.className = "tp-col";
        hCol.id = inputId + "-hcol";

        const mCol = document.createElement("div");
        mCol.className = "tp-col";
        mCol.id = inputId + "-mcol";

        const hLabel = document.createElement("div");
        hLabel.className = "tp-label";
        hLabel.textContent = "Hour";

        const mLabel = document.createElement("div");
        mLabel.className = "tp-label";
        mLabel.textContent = "Min";

        const hWrap = document.createElement("div");
        hWrap.style.cssText = "display:flex;flex-direction:column;flex:1;";
        hWrap.appendChild(hLabel);
        hWrap.appendChild(hCol);

        const mWrap = document.createElement("div");
        mWrap.style.cssText = "display:flex;flex-direction:column;flex:1;";
        mWrap.appendChild(mLabel);
        mWrap.appendChild(mCol);

        const sep = document.createElement("div");
        sep.className = "time-picker-sep";
        sep.textContent = ":";

        const content = document.createElement("div");
        content.className = "time-picker-content";
        content.appendChild(hWrap);
        content.appendChild(sep);
        content.appendChild(mWrap);
        modal.appendChild(content);

        // Populate hour buttons
        for (let h = 0; h < 24; h++) {
          const btn = document.createElement("button");
          btn.className = "tp-btn";
          btn.textContent = String(h).padStart(2, "0");
          btn.dataset.val = String(h).padStart(2, "0");
          btn.addEventListener("click", () => {
            hCol
              .querySelectorAll(".tp-btn")
              .forEach((b) => b.classList.remove("selected"));
            btn.classList.add("selected");
            updatePickerInput(inputId);
          });
          hCol.appendChild(btn);
        }

        // Populate minute buttons
        for (let m = 0; m < 60; m += 5) {
          const btn = document.createElement("button");
          btn.className = "tp-btn";
          btn.textContent = String(m).padStart(2, "0");
          btn.dataset.val = String(m).padStart(2, "0");
          btn.addEventListener("click", () => {
            mCol
              .querySelectorAll(".tp-btn")
              .forEach((b) => b.classList.remove("selected"));
            btn.classList.add("selected");
            updatePickerInput(inputId);
          });
          mCol.appendChild(btn);
        }

        wrapper.appendChild(trigger);
        wrapper.appendChild(modal);

        trigger.addEventListener("click", (e) => {
          e.stopPropagation();
          // Phone: the soft keyboard (numeric) is the picker — the scroll-wheel
          // dropdown would only fight it for screen space.
          if (
            window.innerWidth <= 700 &&
            window.matchMedia("(pointer:coarse)").matches
          )
            return;
          document.querySelectorAll(".time-picker-modal.open").forEach((m) => {
            if (m !== modal) m.classList.remove("open");
          });
          modal.classList.toggle("open");
        });

        document.addEventListener("click", (e) => {
          if (!wrapper.contains(e.target)) modal.classList.remove("open");
        });

        input.addEventListener("change", () => {
          trigger.value = input.value;
          syncPickerToValue(inputId, input.value);
        });

        // Auto-insert colon after 2 digits
        // Auto-insert the colon while typing forward only; on delete, let it
        // go (and take the digit before it) so backspace never sticks on ":".
        trigger.addEventListener("input", (e) => {
          let val = trigger.value.replace(/[^\d:]/g, "");
          const deleting = e.inputType && e.inputType.startsWith("delete");
          if (!deleting && !val.includes(":") && val.length >= 2)
            val = val.slice(0, 2) + ":" + val.slice(2);
          if (val.length > 5) val = val.slice(0, 5);
          trigger.value = val;
        });

        trigger.addEventListener("blur", () => {
          const val = trigger.value.trim();
          if (/^\d{1,2}:\d{2}$/.test(val)) {
            const [h, m] = val.split(":");
            const hh = Math.min(23, parseInt(h) || 0);
            const mm = Math.min(59, Math.round((parseInt(m) || 0) / 5) * 5);
            const timeStr =
              String(hh).padStart(2, "0") + ":" + String(mm).padStart(2, "0");
            trigger.value = timeStr;
            input.value = timeStr;
            syncPickerToValue(inputId, timeStr);
          } else if (val === "") {
            input.value = "";
          }
        });

        // Keep original input hidden inside wrapper so getElementById(inputId) still works
        input.style.display = "none";
        wrapper.appendChild(input);

        if (input.value) syncPickerToValue(inputId, input.value);

        return wrapper;
      }

      function updatePickerInput(inputId) {
        const hCol = document.getElementById(inputId + "-hcol");
        const mCol = document.getElementById(inputId + "-mcol");
        if (!hCol || !mCol) return;
        const h = hCol.querySelector(".tp-btn.selected");
        const m = mCol.querySelector(".tp-btn.selected");
        if (h && m) {
          const timeStr = `${h.dataset.val}:${m.dataset.val}`;
          const input = document.getElementById(inputId);
          if (input) input.value = timeStr;
          const trigger = hCol
            .closest(".time-picker-wrapper")
            ?.querySelector(".time-picker-trigger");
          if (trigger) trigger.value = timeStr;
        }
      }

      function clearTimePicker(inputId) {
        const input = document.getElementById(inputId);
        if (input) input.value = "";
        const wrapper = input?.parentElement;
        const trigger = wrapper?.querySelector(".time-picker-trigger");
        if (trigger) trigger.value = "";
        const hCol = document.getElementById(inputId + "-hcol");
        const mCol = document.getElementById(inputId + "-mcol");
        hCol
          ?.querySelectorAll(".tp-btn.selected")
          .forEach((b) => b.classList.remove("selected"));
        mCol
          ?.querySelectorAll(".tp-btn.selected")
          .forEach((b) => b.classList.remove("selected"));
      }
      function syncPickerToValue(inputId, timeStr) {
        if (!timeStr || !timeStr.includes(":")) return;
        const [h, m] = timeStr.split(":");
        const hVal = String(parseInt(h) || 0).padStart(2, "0");
        const mVal = String(Math.round((parseInt(m) || 0) / 5) * 5).padStart(
          2,
          "0",
        );

        const hCol = document.getElementById(inputId + "-hcol");
        const mCol = document.getElementById(inputId + "-mcol");
        if (!hCol || !mCol) return;

        hCol.querySelectorAll(".tp-btn").forEach((b) => {
          b.classList.toggle("selected", b.dataset.val === hVal);
          if (b.dataset.val === hVal) b.scrollIntoView({ block: "nearest" });
        });
        mCol.querySelectorAll(".tp-btn").forEach((b) => {
          b.classList.toggle("selected", b.dataset.val === mVal);
          if (b.dataset.val === mVal) b.scrollIntoView({ block: "nearest" });
        });
      }

      // ── Multi-select ──────────────────────────────────────────────────────────────
      let selectMode = false;
      let selectedIds = new Set();

      // Mobile entry point into select mode: hold a card ~500ms to enter select
      // mode with that card already checked, mirroring the desktop Select button.
      let longPressTimer = null;
      let longPressFired = false;
      const LONG_PRESS_MS = 500;
      function entryTouchStart(id) {
        longPressFired = false;
        clearTimeout(longPressTimer);
        longPressTimer = setTimeout(() => {
          longPressFired = true;
          if (!selectMode) toggleSelectMode();
          if (!selectedIds.has(id)) toggleEntrySelect(id);
          if (navigator.vibrate) navigator.vibrate(15);
        }, LONG_PRESS_MS);
      }
      function entryTouchEnd(ev) {
        clearTimeout(longPressTimer);
        if (longPressFired && ev) ev.preventDefault();
      }
      function entryTouchMove() {
        clearTimeout(longPressTimer);
      }

      function toggleSelectMode() {
        selectMode = !selectMode;
        selectedIds.clear();
        const btn = document.getElementById("select-mode-btn");
        const list = document.getElementById("entries-list");
        const bar = document.getElementById("bulk-bar");
        if (selectMode) {
          btn.style.background = "var(--accent)";
          btn.style.color = "var(--accent-text)";
          btn.style.borderColor = "var(--accent)";
          list.classList.add("select-mode");
          bar.classList.add("visible");
        } else {
          btn.style.background = "";
          btn.style.color = "";
          btn.style.borderColor = "";
          list.classList.remove("select-mode");
          bar.classList.remove("visible");
        }
        updateBulkBar();
        render();
      }

      function toggleEntrySelect(id) {
        if (selectedIds.has(id)) selectedIds.delete(id);
        else selectedIds.add(id);
        updateBulkBar();
        const card = document.getElementById("card-" + id);
        if (card) {
          const cb = card.querySelector(".entry-checkbox");
          if (cb) cb.checked = selectedIds.has(id);
          card.style.background = selectedIds.has(id) ? "var(--surface2)" : "";
        }
      }

      function updateBulkBar() {
        const count = selectedIds.size;
        document.getElementById("bulk-count").textContent = `${count} selected`;
      }

      async function bulkDelete(confirmed) {
        if (!selectedIds.size) return;
        const count = selectedIds.size;
        if (!confirmed) {
          openTrashConfirm(
            { kind: "bulk" },
            `<b>${count} ${count === 1 ? "entry" : "entries"}</b> will be moved to Trash.`,
          );
          return;
        }
        const toDelete = [...selectedIds]
          .map((id) => entries.find((e) => e.id === id))
          .filter(Boolean);
        const idsForUndo = toDelete.map((e) => e.id);
        if (gcalToken) {
          await Promise.all(
            toDelete.map((e) =>
              e.syncMode === "task"
                ? deleteFromGTask(e, true)
                : deleteFromGCal(e, true),
            ),
          );
        }
        selectedIds.forEach((id) => {
          const idx = entries.findIndex((e) => e.id === id);
          if (idx !== -1) {
            trash.unshift({
              ...entries[idx],
              deletedAt: new Date().toISOString(),
            });
            entries.splice(idx, 1);
          }
        });
        selectedIds.clear();
        save();
        saveTrash();
        updateTrashBadge();
        toggleSelectMode();
        toastWithUndo(
          `${count} ${count === 1 ? "entry" : "entries"} moved to Trash.`,
          () => idsForUndo.forEach((id) => restoreFromTrash(id)),
        );
      }

      function bulkArchive() {
        if (!selectedIds.size) return;
        const count = selectedIds.size;
        selectedIds.forEach((id) => {
          const idx = entries.findIndex((e) => e.id === id);
          if (idx !== -1) {
            entries[idx].archivedAt = new Date().toISOString();
            touchEntry(entries[idx]);
            archived.unshift(entries[idx]);
            entries.splice(idx, 1);
          }
        });
        selectedIds.clear();
        save();
        toggleSelectMode();
        toast(`${count} ${count === 1 ? "entry" : "entries"} archived.`);
      }

      function openBulkMoveModal() {
        if (!selectedIds.size) return;
        const count = selectedIds.size;
        document.getElementById("bulk-move-body").innerHTML =
          `<b>${count} ${count === 1 ? "entry" : "entries"}</b> will move to the date you pick. Multi-day spans keep their length.`;
        document.getElementById("bulk-move-date").value = "";
        document.getElementById("bulk-move-modal").classList.add("open");
      }
      function closeBulkMoveModal() {
        document.getElementById("bulk-move-modal").classList.remove("open");
      }
      document
        .getElementById("bulk-move-modal")
        ?.addEventListener("click", (ev) => {
          if (ev.target.id === "bulk-move-modal") closeBulkMoveModal();
        });
      function bulkMoveOk() {
        const dateStr = v("bulk-move-date");
        if (!dateStr) {
          fieldError("bulk-move-date", "Pick a date.");
          return;
        }
        closeBulkMoveModal();
        bulkMove(dateStr);
      }
      function bulkMove(dateStr) {
        if (!selectedIds.size) return;
        const count = selectedIds.size;
        const moved = [];
        selectedIds.forEach((id) => {
          const e = entries.find((x) => x.id === id);
          if (!e || !e.deadline) return;
          if (e.deadlineEnd) {
            const spanDays = Math.round(
              (new Date(e.deadlineEnd) - new Date(e.deadline)) / 86400000,
            );
            const newEnd = new Date(dateStr);
            newEnd.setDate(newEnd.getDate() + spanDays);
            e.deadlineEnd = newEnd.toISOString().slice(0, 10);
          }
          e.deadline = dateStr;
          touchEntry(e);
          moved.push(e);
        });
        selectedIds.clear();
        save();
        toggleSelectMode();
        toast(`${count} ${count === 1 ? "entry" : "entries"} moved.`);
        if (gcalToken) {
          moved.forEach((e) => {
            if (e.syncMode === "task" && e.gcalTaskId) patchGTask(e);
            else if (e.syncMode !== "task" && e.gcalEventId) patchGCal(e);
          });
        }
      }

      // ── Repeat Entry ──────────────────────────────────────────────────────────────
      let repeatType = "daily";
      let pendingRepeatEntries = [];

      function toggleRepeatUI() {
        const checked = document.getElementById("f-repeat").checked;
        if (checked) {
          updateMonthlyHint();
          refreshRepeatPreview();
          openRepeatPopover();
        } else {
          closeRepeatPopover(true);
          document.getElementById("repeat-calendar-wrap").style.display =
            "none";
        }
      }

      // Repeat builder lives in a popover anchored to the repeat toggle
      // (progressive disclosure: sidebar stays compact; summary line shows
      // the chosen rule with an Edit link).
      function positionRepeatPopover() {
        const pop = document.getElementById("repeat-options");
        const anchor = document.querySelector(".repeat-section");
        if (!pop || !anchor) return;
        const r = anchor.getBoundingClientRect();
        const vw = window.innerWidth,
          vh = window.innerHeight;
        pop.style.left = "";
        pop.style.right = "";
        pop.style.top = "";
        pop.style.bottom = "";
        if (vw < 700) {
          pop.style.left = "12px";
          pop.style.right = "12px";
          pop.style.top = "12px";
          pop.style.width = "auto";
          pop.style.maxHeight = "calc(100vh - 24px)";
          getRepeatCaret().classList.remove("show");
          return;
        }
        pop.style.width = "";
        pop.style.maxHeight = "";
        const caret = getRepeatCaret();
        caret.classList.remove("show");
        const gap = 12;
        let left = r.right + gap;
        const w = pop.offsetWidth || 340;
        if (left + w > vw - 12) left = Math.max(12, r.left);
        let top = r.top;
        const h = pop.offsetHeight || 400;
        if (top + h > vh - 12) top = Math.max(12, vh - 12 - h);
        pop.style.left = left + "px";
        pop.style.top = top + "px";
        // Aim the caret at the vertical centre of the toggle row
        const tog = anchor.querySelector(".repeat-toggle");
        const ty = tog
          ? tog.getBoundingClientRect().top + tog.offsetHeight / 2
          : r.top + 18;
        const ct = Math.min(Math.max(ty - 6, top + 10), top + h - 22);
        if (left >= r.right) {
          caret.style.left = left - 6 + "px";
          caret.style.top = ct + "px";
          caret.classList.add("show");
        }
      }
      function getRepeatCaret() {
        let c = document.getElementById("repeat-caret");
        if (!c) {
          c = document.createElement("div");
          c.id = "repeat-caret";
          c.className = "repeat-caret";
          document.body.appendChild(c);
        }
        return c;
      }
      function openRepeatPopover() {
        const pop = document.getElementById("repeat-options");
        // Portal to <body>: the sidebar is a scroll/transform container, which
        // would make position:fixed resolve against it and clip the popover.
        if (pop.parentElement !== document.body) document.body.appendChild(pop);
        pop.classList.add("open");
        document
          .querySelector(".repeat-section")
          ?.classList.add("popover-open");
        // Re-clamp whenever the popover grows (e.g. preview calendar appears).
        if (!pop._ro && window.ResizeObserver) {
          pop._ro = new ResizeObserver(() => {
            if (pop.classList.contains("open")) positionRepeatPopover();
          });
          pop._ro.observe(pop);
        }
        positionRepeatPopover();
        requestAnimationFrame(positionRepeatPopover);
        document.getElementById("repeat-summary").style.display = "none";
        setTimeout(() => {
          document.addEventListener("mousedown", repeatOutsideClose);
          document.addEventListener("keydown", repeatEscClose);
        }, 0);
        window.addEventListener("resize", repeatPopoverOnResize);
      }
      // rAF-throttled: one reposition per frame while the window is being dragged
      let repeatResizeRaf = 0;
      function repeatPopoverOnResize() {
        if (repeatResizeRaf) return;
        repeatResizeRaf = requestAnimationFrame(() => {
          repeatResizeRaf = 0;
          positionRepeatPopover();
        });
      }
      function closeRepeatPopover(silent) {
        const pop = document.getElementById("repeat-options");
        pop.classList.remove("open");
        getRepeatCaret().classList.remove("show");
        document
          .querySelector(".repeat-section")
          ?.classList.remove("popover-open");
        document.removeEventListener("mousedown", repeatOutsideClose);
        document.removeEventListener("keydown", repeatEscClose);
        window.removeEventListener("resize", repeatPopoverOnResize);
        updateRepeatSummary(silent);
      }
      function repeatOutsideClose(e) {
        const pop = document.getElementById("repeat-options");
        if (pop.contains(e.target)) return;
        if (e.target.closest && e.target.closest(".repeat-toggle")) return;
        closeRepeatPopover();
      }
      function repeatEscClose(e) {
        if (e.key === "Escape") closeRepeatPopover();
      }
      function updateRepeatSummary(hide) {
        const box = document.getElementById("repeat-summary");
        const txt = document.getElementById("repeat-summary-text");
        const on = document.getElementById("f-repeat").checked;
        if (!on || hide) {
          box.style.display = "none";
          return;
        }
        const end = document.getElementById("f-repeat-end")?.value;
        const map = {
          daily: "Daily",
          weekly: "Weekly",
          monthly: "Monthly",
          yearly: "Yearly",
          custom: "Custom dates",
        };
        let s = map[repeatType] || "Repeat";
        if (repeatType === "daily") {
          const n = +document.getElementById("f-repeat-days")?.value || 1;
          if (n > 1) s = `Every ${n} days`;
        }
        if (repeatType === "weekly") {
          const days = [
            ...document.querySelectorAll("#repeat-weekly-opts .active"),
          ]
            .map((b) => b.textContent.trim())
            .join(", ");
          if (days) s += ` · ${days}`;
        }
        s += end ? ` · until ${fmtDate(end)}` : " · end date required";
        const cnt = document.getElementById("repeat-cal-count")?.textContent;
        if (cnt) s += ` · ${cnt}`;
        txt.textContent = s;
        box.style.display = "flex";
      }

      function setRepeatType(type) {
        repeatType = type;
        document
          .querySelectorAll(".repeat-type-btn")
          .forEach((b) =>
            b.classList.toggle("active", b.dataset.rtype === type),
          );
        document.getElementById("repeat-daily-opts").style.display =
          type === "daily" ? "block" : "none";
        document.getElementById("repeat-weekly-opts").style.display =
          type === "weekly" ? "block" : "none";
        document.getElementById("repeat-monthly-opts").style.display =
          type === "monthly" ? "block" : "none";
        document.getElementById("repeat-custom-opts").style.display =
          type === "custom" ? "block" : "none";
        if (type === "monthly") updateMonthlyHint();
        customSelectedDates.clear();
        refreshRepeatPreview();
      }

      function toggleWeekday(btn) {
        btn.classList.toggle("active");
        refreshRepeatPreview();
      }

      // Calendar preview state
      let repeatCalYear = 0,
        repeatCalMonth = 0;
      let customSelectedDates = new Set();

      function refreshRepeatPreview() {
        const startVal =
          document.getElementById("f-deadline")?.value ||
          document.getElementById("f-deadline-task")?.value;
        const endVal = document.getElementById("f-repeat-end")?.value;
        const wrap = document.getElementById("repeat-calendar-wrap");
        if (!startVal || !endVal) {
          wrap.style.display = "none";
          return;
        }
        wrap.style.display = "block";
        // Set calendar to start month if not yet set
        const startD = new Date(startVal + "T00:00:00");
        if (repeatCalYear === 0) {
          repeatCalYear = startD.getFullYear();
          repeatCalMonth = startD.getMonth();
        }
        renderRepeatCal(startVal, endVal);
      }

      function repeatCalNav(dir) {
        repeatCalMonth += dir;
        if (repeatCalMonth > 11) {
          repeatCalMonth = 0;
          repeatCalYear++;
        }
        if (repeatCalMonth < 0) {
          repeatCalMonth = 11;
          repeatCalYear--;
        }
        const startVal =
          document.getElementById("f-deadline")?.value ||
          document.getElementById("f-deadline-task")?.value;
        const endVal = document.getElementById("f-repeat-end")?.value;
        renderRepeatCal(startVal, endVal);
      }

      function renderRepeatCal(startVal, endVal) {
        const generatedDates = new Set(
          generateRepeatDates(startVal, true) || [],
        );
        const startD = new Date(startVal + "T00:00:00");
        const title = document.getElementById("repeat-cal-title");
        const grid = document.getElementById("repeat-cal-grid");
        const countEl = document.getElementById("repeat-cal-count");
        const months = [
          "January",
          "February",
          "March",
          "April",
          "May",
          "June",
          "July",
          "August",
          "September",
          "October",
          "November",
          "December",
        ];
        title.textContent = `${months[repeatCalMonth]} ${repeatCalYear}`;

        const firstDay = new Date(repeatCalYear, repeatCalMonth, 1).getDay();
        const daysInMonth = new Date(
          repeatCalYear,
          repeatCalMonth + 1,
          0,
        ).getDate();
        const hdrs = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

        let html = hdrs
          .map((h) => `<div class="rp-cal-hdr">${h}</div>`)
          .join("");
        for (let i = 0; i < firstDay; i++) html += `<div></div>`;
        for (let d = 1; d <= daysInMonth; d++) {
          const dateStr = `${repeatCalYear}-${String(repeatCalMonth + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
          const isStart = dateStr === startVal;
          const isSelected =
            repeatType === "custom"
              ? customSelectedDates.has(dateStr)
              : generatedDates.has(dateStr);
          const isCustom = repeatType === "custom";
          const cls = [
            "rp-cal-day",
            "this-month",
            isStart ? "start-date" : "",
            isSelected && !isStart ? "selected" : "",
            isCustom && !isStart ? "custom-toggle" : "",
          ]
            .filter(Boolean)
            .join(" ");
          const click =
            isCustom && !isStart
              ? `onclick="toggleCustomDate('${dateStr}')"`
              : "";
          html += `<div class="${cls}" ${click}>${d}</div>`;
        }
        grid.innerHTML = html;

        const totalSelected =
          repeatType === "custom"
            ? customSelectedDates.size
            : generatedDates.size;
        countEl.textContent = totalSelected
          ? `${totalSelected} date${totalSelected === 1 ? "" : "s"} selected`
          : "No dates yet";
      }

      function toggleCustomDate(dateStr) {
        if (customSelectedDates.has(dateStr))
          customSelectedDates.delete(dateStr);
        else customSelectedDates.add(dateStr);
        const startVal =
          document.getElementById("f-deadline")?.value ||
          document.getElementById("f-deadline-task")?.value;
        const endVal = document.getElementById("f-repeat-end")?.value;
        renderRepeatCal(startVal, endVal);
      }

      function updateMonthlyHint() {
        const startDate =
          document.getElementById("f-deadline")?.value ||
          document.getElementById("f-deadline-task")?.value;
        if (!startDate) return;
        const d = new Date(startDate + "T00:00:00");
        const dayOfMonth = d.getDate();
        const weekdays = [
          "Sunday",
          "Monday",
          "Tuesday",
          "Wednesday",
          "Thursday",
          "Friday",
          "Saturday",
        ];
        const weekday = weekdays[d.getDay()];
        const nthWeek = Math.ceil(dayOfMonth / 7);
        const nth = ["", "1st", "2nd", "3rd", "4th", "5th"][nthWeek];
        const hint = document.getElementById("monthly-pattern-hint");
        if (hint)
          hint.textContent = `Day ${dayOfMonth} of month  ·  ${nth} ${weekday} of month`;
      }

      function generateRepeatDates(startDate, silent = false) {
        const endVal = document.getElementById("f-repeat-end")?.value;
        if (!endVal) {
          if (!silent) toast("Set an end date for the repeat.");
          return null;
        }
        const start = new Date(startDate + "T00:00:00");
        const end = new Date(endVal + "T00:00:00");
        if (end <= start) {
          if (!silent) toast("End date must be after the start date.");
          return null;
        }

        const dates = [];
        const addDate = (d) => {
          const y = d.getFullYear();
          const m = String(d.getMonth() + 1).padStart(2, "0");
          const day = String(d.getDate()).padStart(2, "0");
          dates.push(`${y}-${m}-${day}`);
        };

        if (repeatType === "daily") {
          const n =
            parseInt(document.getElementById("f-repeat-days").value) || 1;
          const cur = new Date(start);
          cur.setDate(cur.getDate() + n);
          while (cur <= end) {
            addDate(cur);
            cur.setDate(cur.getDate() + n);
          }
        } else if (repeatType === "weekly") {
          const activeDays = [
            ...document.querySelectorAll(".repeat-weekday-btn.active"),
          ].map((b) => parseInt(b.dataset.day));
          if (!activeDays.length) {
            if (!silent) toast("Select at least one weekday.");
            return null;
          }
          const cur = new Date(start);
          cur.setDate(cur.getDate() + 1);
          while (cur <= end) {
            if (activeDays.includes(cur.getDay())) addDate(cur);
            cur.setDate(cur.getDate() + 1);
          }
        } else if (repeatType === "monthly") {
          const useWeekday = document.getElementById("monthly-weekday").checked;
          const dayOfMonth = start.getDate();
          const targetDay = start.getDay();
          const nthWeek = Math.ceil(dayOfMonth / 7);
          const cur = new Date(start.getFullYear(), start.getMonth(), 1);
          while (cur <= end) {
            if (useWeekday) {
              // Find nth occurrence of targetDay in this month
              const firstOfMonth = new Date(
                cur.getFullYear(),
                cur.getMonth(),
                1,
              );
              let count = 0;
              let d = new Date(firstOfMonth);
              while (d.getMonth() === cur.getMonth()) {
                if (d.getDay() === targetDay) {
                  count++;
                  if (count === nthWeek) {
                    addDate(d);
                    break;
                  }
                }
                d.setDate(d.getDate() + 1);
              }
            } else {
              const candidate = new Date(
                cur.getFullYear(),
                cur.getMonth(),
                dayOfMonth,
              );
              if (candidate.getMonth() === cur.getMonth() && candidate <= end)
                addDate(candidate);
            }
            cur.setMonth(cur.getMonth() + 1);
          }
        } else if (repeatType === "yearly") {
          const cur = new Date(start);
          cur.setFullYear(cur.getFullYear() + 1);
          while (cur <= end) {
            const candidate = new Date(
              cur.getFullYear(),
              start.getMonth(),
              start.getDate(),
            );
            if (candidate <= end) addDate(candidate);
            cur.setFullYear(cur.getFullYear() + 1);
          }
        } else if (repeatType === "custom") {
          return [...customSelectedDates].sort();
        }

        // Safety net: the base entry already covers startDate — never repeat it
        // (can happen in monthly mode when the target day/weekday falls in the starting month).
        return dates.filter((d) => d !== startDate);
      }

      function openRepeatModal(baseEntry, dates) {
        pendingRepeatEntries = dates.map((d) => ({
          ...baseEntry,
          id: Date.now() + Math.random(),
          deadline: d,
          deadlineEnd: "",
          gcalEventId: null,
          gtaskId: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }));
        const list = document.getElementById("repeat-date-list");
        list.innerHTML = pendingRepeatEntries
          .map(
            (e, i) => `
    <label class="repeat-date-item">
      <input type="checkbox" checked data-idx="${i}" onchange="updateRepeatCount()"/>
      <span>${fmtDate(e.deadline)}</span>
    </label>`,
          )
          .join("");
        updateRepeatCount();
        document.getElementById("repeat-modal-overlay").classList.add("open");
      }

      function updateRepeatCount() {
        const checked = document.querySelectorAll(
          "#repeat-date-list input[type=checkbox]:checked",
        ).length;
        document.getElementById("repeat-selected-count").textContent =
          `${checked} of ${pendingRepeatEntries.length} dates selected`;
      }

      function closeRepeatModal() {
        document
          .getElementById("repeat-modal-overlay")
          .classList.remove("open");
        pendingRepeatEntries = [];
      }

      function confirmRepeatEntries() {
        const selected = [
          ...document.querySelectorAll(
            "#repeat-date-list input[type=checkbox]:checked",
          ),
        ].map((cb) => parseInt(cb.dataset.idx));
        if (!selected.length) {
          toast("Select at least one date.");
          return;
        }
        const toAdd = selected.map((i) => pendingRepeatEntries[i]);
        toAdd.forEach((e) => {
          e.id = Date.now() + Math.floor(Math.random() * 9999);
          entries.unshift(e);
        });
        save();
        render();
        closeRepeatModal();
        document.getElementById("f-repeat").checked = false;
        toggleRepeatUI();
        clearForm();
        closeMobileSidebar();
        toast(
          `${toAdd.length} repeated ${toAdd.length === 1 ? "entry" : "entries"} created.`,
        );
        if (gcalToken) {
          toAdd.forEach((e) => {
            if (e.syncMode === "task") pushToGTask(e, true);
            else pushToGCal(e, true);
          });
        }
      }

      function clearForm() {
        ["f-name", "f-remark", "f-deadline-end"].forEach(
          (id) => (document.getElementById(id).value = ""),
        );
        clearTimePicker("f-time");
        clearTimePicker("f-time-to");
        document.getElementById("f-type").value = "";
        document.getElementById("f-deadline").value = today();
        document.getElementById("f-deadline-task").value = today();
        // Reset repeat
        const repeatCb = document.getElementById("f-repeat");
        if (repeatCb) {
          repeatCb.checked = false;
          toggleRepeatUI();
        }
        document.getElementById("f-repeat-end") &&
          (document.getElementById("f-repeat-end").value = "");
        document.getElementById("f-repeat-days") &&
          (document.getElementById("f-repeat-days").value = "1");
        document
          .querySelectorAll(".repeat-weekday-btn.active")
          .forEach((b) => b.classList.remove("active"));
        customSelectedDates.clear();
        repeatCalYear = 0;
        repeatCalMonth = 0;
        setRepeatType("daily");
      }

      // ── Render ─────────────────────────────────────────────────────────────────
      // ── Sort ───────────────────────────────────────────────────────────────────
      function sorted(source) {
        const copy = [...source];
        let result;
        if (sortMode === "oldest") result = [...copy].reverse();
        else if (sortMode === "deadline")
          result = copy.sort((a, b) => {
            if (!a.deadline) return 1;
            if (!b.deadline) return -1;
            const deadlineCmp = a.deadline.localeCompare(b.deadline);
            if (deadlineCmp !== 0) return deadlineCmp;
            // Same deadline: sub-sort by time (earlier times first)
            const aTime = a.time || "";
            const bTime = b.time || "";
            return aTime.localeCompare(bTime);
          });
        else if (sortMode === "name")
          result = copy.sort((a, b) => a.name.localeCompare(b.name));
        else result = copy; // newest (already newest-first from unshift)
        if (sortDir === "asc") result = result.reverse();
        // Pin newly added entry at top until user changes sort or refreshes
        if (pinnedId !== null) {
          const idx = result.findIndex((e) => e.id === pinnedId);
          if (idx > 0) {
            result.unshift(result.splice(idx, 1)[0]);
          }
        }
        return result;
      }

      function toggleSortDir() {
        sortDir = sortDir === "desc" ? "asc" : "desc";
        pinnedId = null;
        const btn = document.getElementById("sort-dir-btn");
        if (btn) {
          btn.title =
            sortDir === "asc"
              ? "Currently ascending — click for descending"
              : "Currently descending — click for ascending";
          btn.innerHTML =
            sortDir === "asc"
              ? `<svg class="icon sm" viewBox="0 0 24 24"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>`
              : `<svg class="icon sm" viewBox="0 0 24 24"><line x1="12" y1="5" x2="12" y2="19"/><polyline points="19 12 12 19 5 12"/></svg>`;
        }
        render();
      }

      function populateTypeSelects() {
        const types = allTypes();
        const makeOpts = (selected = "") =>
          `<option value="">— Select type —</option>` +
          types
            .map(
              (t) =>
                `<option${selected === t ? " selected" : ""}>${esc(t)}</option>`,
            )
            .join("");
        const fs = document.getElementById("f-type");
        if (fs) {
          const cur = fs.value;
          fs.innerHTML = makeOpts(cur);
        }
      }

      function toggleView() {
        viewMode = viewMode === "active" ? "archive" : "active";
        selectedFilterTypes = [];
        document.getElementById("view-toggle-label").textContent =
          viewMode === "active" ? "View Archive" : "Back to Active";
        document.getElementById("main-title").textContent =
          viewMode === "active" ? "Entries" : "Archive";
        document.querySelector(".sidebar").style.opacity =
          viewMode === "archive" ? "0.4" : "1";
        document.querySelector(".sidebar").style.pointerEvents =
          viewMode === "archive" ? "none" : "";
        // Archive view defaults to ascending sort (oldest/completed entries first)
        // Active view defaults to descending sort (newest first)
        if (viewMode === "archive") {
          sortDir = "asc";
          const btn = document.getElementById("sort-dir-btn");
          if (btn) {
            btn.title = "Currently ascending — click for descending";
            btn.innerHTML = `<svg class="icon sm" viewBox="0 0 24 24"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>`;
          }
        } else {
          sortDir = "desc";
          const btn = document.getElementById("sort-dir-btn");
          if (btn) {
            btn.title = "Currently descending — click for ascending";
            btn.innerHTML = `<svg class="icon sm" viewBox="0 0 24 24"><line x1="12" y1="5" x2="12" y2="19"/><polyline points="19 12 12 19 5 12"/></svg>`;
          }
        }
        render();
      }

      function calculateStats(source) {
        const now = new Date();
        now.setHours(0, 0, 0, 0);
        let overdue = 0,
          today = 0,
          soon = 0;
        source.forEach((e) => {
          if (!e.deadline) return;
          const start = new Date(e.deadline);
          start.setHours(0, 0, 0, 0);
          const end = e.deadlineEnd ? new Date(e.deadlineEnd) : start;
          end.setHours(0, 0, 0, 0);
          const isMultiDay = e.deadlineEnd && e.deadline !== e.deadlineEnd;
          if (isMultiDay) {
            const endDiff = Math.round((end - now) / 86400000);
            if (endDiff < 0) overdue++;
            else if (endDiff === 0) soon++;
            else if (Math.round((start - now) / 86400000) <= 0) soon++;
            else if (Math.round((start - now) / 86400000) <= 3) soon++;
          } else {
            const diff = Math.round((start - now) / 86400000);
            if (diff < 0) overdue++;
            else if (diff === 0) today++;
            else if (diff <= 3) soon++;
          }
        });
        return { overdue, today, soon, total: source.length };
      }

      function render() {
        const source = viewMode === "active" ? entries : archived;
        const types = [
          "All",
          ...new Set(source.map((e) => e.type).filter(Boolean)),
        ];
        const fb = document.getElementById("filter-bar");

        // Build stat cards row with 5 metrics
        const allTaskCount = entries.length + archived.length;
        const entriesCount = entries.length;
        const archiveCount = archived.length;

        // Calculate today (due today + in progress)
        const now = new Date();
        now.setHours(0, 0, 0, 0);
        let todayCount = 0;
        entries.forEach((e) => {
          if (!e.deadline) return;
          const start = new Date(e.deadline);
          start.setHours(0, 0, 0, 0);
          const end = e.deadlineEnd ? new Date(e.deadlineEnd) : start;
          end.setHours(0, 0, 0, 0);
          const isMultiDay = e.deadlineEnd && e.deadline !== e.deadlineEnd;
          if (isMultiDay) {
            const startDiff = Math.round((start - now) / 86400000);
            const endDiff = Math.round((end - now) / 86400000);
            if (startDiff <= 0 && endDiff > 0) todayCount++;
            else if (endDiff === 0) todayCount++;
          } else {
            const diff = Math.round((start - now) / 86400000);
            if (diff === 0) todayCount++;
          }
        });

        // Calculate overdue
        let overdueCount = 0;
        entries.forEach((e) => {
          if (!e.deadline) return;
          const start = new Date(e.deadline);
          start.setHours(0, 0, 0, 0);
          const end = e.deadlineEnd ? new Date(e.deadlineEnd) : start;
          end.setHours(0, 0, 0, 0);
          const isMultiDay = e.deadlineEnd && e.deadline !== e.deadlineEnd;
          if (isMultiDay) {
            const endDiff = Math.round((end - now) / 86400000);
            if (endDiff < 0) overdueCount++;
          } else {
            const diff = Math.round((start - now) / 86400000);
            if (diff < 0) overdueCount++;
          }
        });

        // Slim inline stat strip — numbers at a glance, no card chrome
        const stripEl = document.getElementById("stat-strip");
        if (stripEl) {
          stripEl.innerHTML =
            `<span><b>${allTaskCount}</b>All</span>` +
            `<span><b>${entriesCount}</b>Active</span>` +
            `<span><b>${archiveCount}</b>Archived</span>` +
            `<span><b style="color:var(--warn);">${todayCount}</b>Today</span>` +
            `<span><b style="color:var(--danger);">${overdueCount}</b>Overdue</span>`;
        }

        // Filter chips (chips only — sync/search/sort are static toolbar controls)
        // Type name lives in a data attribute, not inside an inline JS string —
        // esc() turns ' into &#39; which the HTML parser decodes right back to '
        // inside onclick="…('…')", giving a SyntaxError for names like O'Brien.
        fb.innerHTML = types
          .map(
            (t) =>
              `<button class="filter-chip${(t === "All" ? selectedFilterTypes.length === 0 : selectedFilterTypes.includes(t)) ? " active" : ""}" data-type="${esc(t)}" onclick="toggleFilterType(this.dataset.type)">${esc(t)}</button>`,
          )
          .join("");
        const syncAllEl = document.getElementById("sync-all-btn");
        if (syncAllEl)
          syncAllEl.style.display =
            gcalToken && viewMode === "active" ? "" : "none";

        // Update archive count badge
        const archiveBadge = document.getElementById("archive-count");
        if (archiveBadge) archiveBadge.textContent = "";

        // Layout toggle state + calendar dispatch. Calendar exists for active
        // entries only — Archive always shows the list.
        const calMode = viewLayout === "calendar" && viewMode === "active";
        const layoutToggle = document.getElementById("view-layout-toggle");
        if (layoutToggle) {
          layoutToggle.style.display = viewMode === "archive" ? "none" : "flex";
          document
            .getElementById("layout-list-btn")
            .classList.toggle("active", viewLayout === "list");
          document
            .getElementById("layout-cal-btn")
            .classList.toggle("active", viewLayout === "calendar");
        }
        // List-only controls (Select / sort / direction). Toggled via a body class
        // so CSS hides them with visibility (space kept) — the chip area, search
        // box and everything below stay put on every breakpoint.
        document.body.classList.toggle("cal-tools", calMode);
        // Mobile + button: adding is disabled while viewing the Archive
        const fabEl = document.getElementById("fab-add");
        if (fabEl) fabEl.style.display = viewMode === "archive" ? "none" : "";
        if (calMode) {
          renderCalendar();
          return;
        }
        document.body.classList.remove("cal-fit");

        const filtered =
          selectedFilterTypes.length === 0
            ? sorted(source)
            : sorted(source).filter((e) =>
                selectedFilterTypes.includes(e.type),
              );
        const shown = filtered.filter((e) => matchesSearch(e, searchQuery));
        document.getElementById("entry-count").textContent = shown.length;
        const list = document.getElementById("entries-list");
        if (!shown.length) {
          const msg =
            viewMode === "archive"
              ? "No archived entries."
              : "No entries yet.<br>Add your first task using the form.";
          const icon = viewMode === "archive" ? "🗄️" : "📋";
          list.innerHTML = `<div class="empty-state"><div class="empty-icon">${icon}</div><p>${msg}</p></div>`;
          return;
        }
        try {
          list.innerHTML = shown
            .map((e) => entryHTML(e, viewMode === "archive"))
            .join("");
        } catch (err) {
          list.innerHTML = `<div class="empty-state"><p style="color:red;">Render error: ${err.message}</p></div>`;
          console.error("entryHTML error:", err);
        }

        // Initialize time pickers for edit modal if in edit mode
        if (editingId) {
          setTimeout(() => {
            initializeEditTimePickers(editingId);
          }, 0);
        }
      }

      function entryHTML(e, isArchived = false) {
        const cardColor = typeColors[e.type] || null;
        const status = isArchived
          ? ""
          : deadlineStatus(e.deadline, e.deadlineEnd);
        const isEditing = editingId === e.id;
        const types = allTypes();
        const typeOpts = types
          .map(
            (t) =>
              `<option${e.type === t ? " selected" : ""}>${esc(t)}</option>`,
          )
          .join("");
        const selectedStyle =
          selectMode && !isArchived && selectedIds.has(e.id)
            ? "background:var(--surface2);"
            : "";
        const colorStyle =
          cardColor || selectedStyle
            ? ` style="${cardColor ? `border-left:3px solid ${esc(cardColor)};padding-left:13px;` : ""}${selectedStyle}"`
            : "";

        const isTaskEntry = e.syncMode === "task";
        if (isEditing)
          return `
    <div class="entry-card editing" id="card-${e.id}">
      <div class="entry-top">
        <div class="entry-body">
          <div class="edit-fields">
            <div><label class="field-label">Work name</label><input type="text" id="edit-name-${e.id}" value="${esc(e.name)}"/></div>
            <div class="sync-mode-toggle" style="margin-bottom:0;">
              <button class="sync-mode-btn${isTaskEntry ? "" : " active"}" id="edit-mode-event-${e.id}" onclick="setEditSyncMode(${e.id},'event')">Event</button>
              <button class="sync-mode-btn${isTaskEntry ? " active" : ""}" id="edit-mode-task-${e.id}" onclick="setEditSyncMode(${e.id},'task')">Task</button>
            </div>
            <input type="hidden" id="edit-syncmode-${e.id}" value="${isTaskEntry ? "task" : "event"}"/>
            <div class="edit-row2">
              <div><label class="field-label">Type</label>
                <select id="edit-type-${e.id}"><option value="">— type —</option>${typeOpts}</select>
              </div>
              <div id="edit-dates-task-${e.id}" style="grid-column:span 2;display:${isTaskEntry ? "block" : "none"};"><label class="field-label">Due date</label><input type="date" id="edit-deadline-task-${e.id}" value="${e.deadline || ""}"/></div>
              <div id="edit-dates-event-${e.id}" style="display:${isTaskEntry ? "none" : "contents"};">
                <div><label class="field-label">Start date</label><input type="date" id="edit-deadline-${e.id}" value="${e.deadline || ""}"/></div>
                <div><label class="field-label">End date</label><input type="date" id="edit-deadline-end-${e.id}" value="${e.deadlineEnd || ""}" title="Leave blank for single day"/></div>
              </div>
            </div>
            <div><label class="field-label">Time<span id="edit-time-label-note-${e.id}">${isTaskEntry ? " (shown in task title)" : ""}</span></label><div style="display:flex;gap:6px;align-items:center;"><input type="time" id="edit-time-${e.id}" value="${e.time || ""}" style="flex:1;"/><span style="font-size:12px;color:var(--text3);">→</span><input type="time" id="edit-time-to-${e.id}" value="${e.timeTo || ""}" style="flex:1;"/></div></div>
            <div><label class="field-label">Remark</label><textarea id="edit-remark-${e.id}" style="min-height:70px;">${esc(e.remark || "")}</textarea></div>
            <div class="edit-actions">
              <button class="btn btn-sm" onclick="cancelEdit()">Cancel</button>
              <button class="btn btn-primary btn-sm" onclick="saveEdit(${e.id})">Save changes</button>
            </div>
          </div>
        </div>
      </div>
    </div>`;

        const typeChip = e.type
          ? (() => {
              const dot = cardColor
                ? `<span style="width:7px;height:7px;border-radius:50%;background:${esc(cardColor)};display:inline-block;margin-right:3px;flex-shrink:0;vertical-align:middle;"></span>`
                : "";
              const chipStyle = cardColor
                ? ` style="background:${esc(cardColor)}22;color:${esc(cardColor)};border-color:${esc(cardColor)}55;"`
                : "";
              return `<span class="chip type"${chipStyle}>${dot}${esc(e.type)}</span>`;
            })()
          : "";

        const deadlineChip = e.deadline
          ? (() => {
              const rangeStr = e.deadlineEnd
                ? `${fmtDate(e.deadline)} → ${fmtDate(e.deadlineEnd)}`
                : fmtDate(e.deadline);
              const timeStr = e.time
                ? " · " +
                  fmtTime(e.time) +
                  (e.timeTo ? " → " + fmtTime(e.timeTo) : "")
                : "";
              const statusLabel =
                status === " overdue"
                  ? " · overdue"
                  : status === " today"
                    ? " · I am due <b>TODAY!!!</b>. Don't forget to do me. <b>YAY!!!</b>"
                    : status === " soon"
                      ? " · soon"
                      : status === " in-progress"
                        ? " · In Progress"
                        : status === " last-day"
                          ? " · <b>Hey, Last Chance</b>, is this done yet?"
                          : "";
              return `<span class="chip deadline${status}">${rangeStr}${timeStr}${statusLabel.includes("<b>") ? statusLabel : esc(statusLabel)}</span>`;
            })()
          : "";

        const selectCb =
          selectMode && !isArchived
            ? `<input type="checkbox" class="entry-checkbox" ${selectedIds.has(e.id) ? "checked" : ""} onclick="event.stopPropagation();toggleEntrySelect(${e.id})"/>`
            : "";
        const cardClick =
          selectMode && !isArchived
            ? ` onclick="toggleEntrySelect(${e.id})"`
            : "";
        const longPressAttrs = isArchived
          ? ""
          : ` ontouchstart="entryTouchStart(${e.id})" ontouchend="entryTouchEnd(event)" ontouchmove="entryTouchMove()"`;

        return `
    <div class="entry-card" id="card-${e.id}"${colorStyle}${cardClick}${longPressAttrs}>
      <div class="entry-top">
        <div class="entry-body">
          <div class="entry-name">${highlight(e.name, searchQuery)}</div>
          ${e.remark ? `<div class="entry-remark">${esc(e.remark)}</div>` : ""}
          <div class="entry-meta">
            ${isTaskEntry ? `<span class="chip task-mode">Task</span>` : ""}
            ${typeChip}
            ${deadlineChip}
          </div>
        </div>
        <div class="entry-actions">
          ${
            isArchived
              ? `
            <button class="icon-btn" title="Restore to active" onclick="restoreEntry(${e.id})" style="color:var(--success);">${restoreIcon()}</button>
            <button class="icon-btn del" title="Delete permanently" onclick="deleteArchived(${e.id})">${trashForeverIcon()}</button>
          `
              : `
            ${
              gcalToken && e.deadline
                ? isTaskEntry
                  ? `<button class="icon-btn cal" title="Sync to Google Tasks" onclick="pushToGTask(entries.find(x=>x.id===${e.id}))">${taskSyncIcon()}</button>`
                  : `<button class="icon-btn cal" title="Sync to Google Calendar" onclick="pushToGCal(entries.find(x=>x.id===${e.id}))">${calIcon()}</button>`
                : ""
            }
            <button class="icon-btn" title="Edit entry" onclick="startEdit(${e.id})">${editIcon()}</button>
            <button class="icon-btn" title="Archive entry" onclick="archiveEntry(${e.id})" style="color:var(--text3);">${archiveIcon()}</button>
            <button class="icon-btn del" title="Move to Trash" onclick="deleteEntry(${e.id})">${trashIcon()}</button>
          `
          }
          ${selectCb}
        </div>
      </div>
    </div>`;
      }

      function deadlineStatus(d, dEnd) {
        if (!d) return "";
        const now = new Date();
        now.setHours(0, 0, 0, 0);
        const start = new Date(d);
        start.setHours(0, 0, 0, 0);
        const end = dEnd ? new Date(dEnd) : start;
        end.setHours(0, 0, 0, 0);

        const isMultiDay = dEnd && d !== dEnd;

        if (isMultiDay) {
          const startDiff = Math.round((start - now) / 86400000);
          const endDiff = Math.round((end - now) / 86400000);

          if (endDiff < 0) return " overdue";
          if (endDiff === 0) return " last-day";
          if (startDiff <= 0 && endDiff > 0) return " in-progress";
          if (startDiff > 0 && startDiff <= 3) return " soon";
          return "";
        } else {
          const diff = Math.round((start - now) / 86400000);
          if (diff < 0) return " overdue";
          if (diff === 0) return " today";
          if (diff <= 3) return " soon";
          return "";
        }
      }

      function fmtDate(d) {
        if (!d) return "";
        const [y, m, day] = d.split("-");
        return (
          [
            "Jan",
            "Feb",
            "Mar",
            "Apr",
            "May",
            "Jun",
            "Jul",
            "Aug",
            "Sep",
            "Oct",
            "Nov",
            "Dec",
          ][+m - 1] +
          " " +
          parseInt(day) +
          ", " +
          y
        );
      }

      function fmtTime(t) {
        if (!t) return "";
        const [h, m] = t.split(":");
        const hr = parseInt(h);
        return (hr % 12 || 12) + ":" + m + (hr < 12 ? "AM" : "PM");
      }
      function esc(s) {
        return String(s || "")
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;")
          .replace(/'/g, "&#39;");
      }

      // ── Calendar View ───────────────────────────────────────────────────────────
      // Month grid renderer (GCal-style). Multi-day entries render as spanning bars
      // per week row with greedy lane stacking; single-day entries render as chips
      // below the bars. Filters and search apply exactly as in the list view.
      function setViewLayout(mode) {
        if (viewLayout === mode) return;
        viewLayout = mode;
        if (selectMode) toggleSelectMode(); // bulk select is a list-only concept
        // An open inline edit can't survive the switch — clear it, or its stale
        // editingId suppresses every sync-driven re-render in calendar mode and
        // the abandoned card resurrects when switching back.
        if (editingId !== null) editingId = null;
        render();
      }

      const CAL_MONTHS = [
        "January",
        "February",
        "March",
        "April",
        "May",
        "June",
        "July",
        "August",
        "September",
        "October",
        "November",
        "December",
      ];

      function calNav(dir) {
        if (calView === "year") {
          calYear += dir;
          render();
          return;
        }
        calMonth += dir;
        if (calMonth < 0) {
          calMonth = 11;
          calYear--;
        }
        if (calMonth > 11) {
          calMonth = 0;
          calYear++;
        }
        render();
      }
      function calGoToday() {
        const n = new Date();
        calYear = n.getFullYear();
        calMonth = n.getMonth();
        calScrollToToday = true;
        render();
      }
      let calScrollToToday = false;
      function calSetMonth(m) {
        calMonth = parseInt(m);
        render();
      }
      function calSetYear(y) {
        calYear = parseInt(y);
        render();
      }
      function calSetCalView(v) {
        calView = v;
        localStorage.setItem("wl2dev_cal_view", v);
        render();
      }
      function calOpenMonth(m) {
        calMonth = m;
        calSetCalView("month");
      }
      function calOpenDayFromYear(ds) {
        const p = ds.split("-");
        calYear = parseInt(p[0]);
        calMonth = parseInt(p[1]) - 1;
        calView = "month";
        localStorage.setItem("wl2dev_cal_view", "month");
        render();
        openCalDay(ds);
      }

      // Readable text colour for a solid type-colour background
      function calTextOn(hex) {
        if (!hex || hex[0] !== "#" || hex.length < 7)
          return "var(--accent-text)";
        const r = parseInt(hex.slice(1, 3), 16),
          g = parseInt(hex.slice(3, 5), 16),
          b = parseInt(hex.slice(5, 7), 16);
        return 0.299 * r + 0.587 * g + 0.114 * b > 150 ? "#1F1D1A" : "#FFFFFF";
      }

      // Task checkbox on calendar chips — marks the task done/not-done and mirrors
      // the state to Google Tasks when connected.
      function toggleTaskDone(id) {
        const inEntries = entries.some((x) => x.id === id);
        const e = inEntries
          ? entries.find((x) => x.id === id)
          : archived.find((x) => x.id === id);
        if (!e || e.syncMode !== "task") return;
        const wasCompleted = e.completed;
        e.completed = !e.completed;
        touchEntry(e);
        if (e.completed && !wasCompleted && inEntries) {
          e.archivedAt = new Date().toISOString();
          archived.unshift(e);
          entries = entries.filter((x) => x.id !== id);
          toast("Task completed and archived.");
        } else if (!e.completed && wasCompleted && !inEntries) {
          delete e.archivedAt;
          archived = archived.filter((x) => x.id !== id);
          entries.unshift(e);
          toast("Task restored.");
        }
        save();
        render();
        if (gcalToken && e.gcalTaskId) patchGTask(e, true);
      }

      function calDateStr(y, m, d) {
        return (
          y +
          "-" +
          String(m + 1).padStart(2, "0") +
          "-" +
          String(d).padStart(2, "0")
        );
      }

      // All visible (filter+search applied) active entries covering a given date.
      function calDayEntries(ds) {
        const covers = (e) =>
          e.deadline &&
          (e.deadlineEnd && e.deadlineEnd > e.deadline
            ? e.deadline <= ds && e.deadlineEnd >= ds
            : e.deadline === ds);
        const match = (e) =>
          (selectedFilterTypes.length === 0 ||
            selectedFilterTypes.includes(e.type)) &&
          matchesSearch(e, searchQuery);
        const act = entries.filter(covers).filter(match);
        const arc = archived.filter(covers).filter(match);
        const byTime = (a, b) =>
          (a.time ? 1 : 0) - (b.time ? 1 : 0) ||
          (a.time || "").localeCompare(b.time || "");
        return act.sort(byTime).concat(arc.sort(byTime)); // archived last
      }

      // GCal-style distinction: all-day events are solid colour bands; timed
      // events (and all tasks) are dot/checkbox + time + name on a plain background.
      function calChipHTML(e) {
        const arch = calArchIdSet.has(e.id);
        const color = typeColors[e.type] || null;
        const swatch = color || "var(--accent)";
        const overdue =
          !arch &&
          !e.completed &&
          deadlineStatus(e.deadline, e.deadlineEnd) === " overdue";
        const isTask = e.syncMode === "task";

        if (!isTask && !e.time) {
          // All-day event → solid band
          const fg = color ? calTextOn(color) : "var(--accent-text)";
          return `<span class="cal-chip${overdue ? " overdue" : ""}${arch ? " arch" : ""}" role="button" tabindex="0" title="${esc(e.name)}" onclick="event.stopPropagation();openCalEntry(${e.id})" style="background:${esc(swatch)};color:${fg};"><span class="cal-chip-name">${esc(e.name)}</span></span>`;
        }

        const t = e.time
          ? `<span class="cal-chip-time">${fmtTime(e.time)}</span>`
          : "";
        const marker = isTask
          ? arch
            ? `<span class="cal-chip-task" style="color:${esc(swatch)};cursor:default;">${e.completed ? "✓" : ""}</span>`
            : `<span class="cal-chip-task" role="button" tabindex="0" aria-label="Toggle done" style="color:${esc(swatch)};" onclick="event.stopPropagation();toggleTaskDone(${e.id})" title="${e.completed ? "Mark as not done" : "Mark as done"}">${e.completed ? "✓" : ""}</span>`
          : `<span class="cal-chip-dot" style="background:${esc(swatch)};"></span>`;
        return `<span class="cal-chip plain${overdue ? " overdue" : ""}${e.completed ? " done" : ""}${arch ? " arch" : ""}" role="button" tabindex="0" title="${esc(e.name)}" onclick="event.stopPropagation();openCalEntry(${e.id})">${marker}${t}<span class="cal-chip-name">${esc(e.name)}</span></span>`;
      }

      function renderCalendar() {
        // Pin the shell to the viewport BEFORE measuring, so the chip-capacity
        // math below sees the real bounded height on the very first render.
        document.body.classList.add("cal-fit");
        const list = document.getElementById("entries-list");
        const calFilter = (e) =>
          (selectedFilterTypes.length === 0 ||
            selectedFilterTypes.includes(e.type)) &&
          matchesSearch(e, searchQuery);
        const visible = entries.filter(calFilter);
        document.getElementById("entry-count").textContent = visible.length;
        const dated = visible.filter((e) => e.deadline);
        const undatedCount = visible.length - dated.length;
        // Archived entries appear in the MONTH grid as struck-through ghosts
        // (year view stays active-only — its colour dots are a planning overview).
        const archDated = archived.filter(calFilter).filter((e) => e.deadline);
        calArchIdSet = new Set(archDated.map((e) => e.id));

        const monthOpts = CAL_MONTHS.map(
          (m, i) =>
            `<option value="${i}"${i === calMonth ? " selected" : ""}>${m}</option>`,
        ).join("");
        // Year range: ±10 around the viewed year, always including today's year
        // and every year that actually holds an entry.
        const entryYears = dated
          .map((e) => parseInt(e.deadline.slice(0, 4)))
          .filter((y) => !isNaN(y));
        const yMin =
          Math.min(
            calYear,
            new Date().getFullYear(),
            ...(entryYears.length ? entryYears : [calYear]),
          ) - 10;
        const yMax =
          Math.max(
            calYear,
            new Date().getFullYear(),
            ...(entryYears.length ? entryYears : [calYear]),
          ) + 10;
        let yearOpts = "";
        for (let y = yMin; y <= yMax; y++) {
          yearOpts += `<option value="${y}"${y === calYear ? " selected" : ""}>${y}</option>`;
        }

        let html = `<div class="cal-wrap">
    <div class="cal-header">
      <button class="cal-nav-btn" onclick="calNav(-1)" title="Previous ${calView === "year" ? "year" : "month"}">‹</button>
      ${calView === "month" ? `<select class="cal-title-sel" onchange="calSetMonth(this.value)" title="Jump to month">${monthOpts}</select>` : ""}
      <select class="cal-title-sel" onchange="calSetYear(this.value)" title="Jump to year">${yearOpts}</select>
      <button class="cal-nav-btn" onclick="calNav(1)" title="Next ${calView === "year" ? "year" : "month"}">›</button>
      <button class="btn btn-sm" onclick="calGoToday()">Today</button>
      <div class="sync-mode-toggle" style="margin-bottom:0;display:flex;flex-shrink:0;background:var(--surface);">
        <button class="sync-mode-btn${calView === "month" ? " active" : ""}" onclick="calSetCalView('month')" style="padding:4px 12px;white-space:nowrap;">Month</button>
        <button class="sync-mode-btn${calView === "year" ? " active" : ""}" onclick="calSetCalView('year')" style="padding:4px 12px;white-space:nowrap;">Year</button>
      </div>
      ${undatedCount ? `<span class="cal-undated" role="button" tabindex="0" onclick="setViewLayout('list')">${undatedCount} undated ${undatedCount === 1 ? "entry" : "entries"} — view in list</span>` : ""}
    </div>`;

        html +=
          calView === "year"
            ? calYearHTML(dated)
            : calMonthHTML(dated.concat(archDated), list.clientHeight);
        html += `</div>`;
        const prevYearScroll =
          list.querySelector(".cal-year-grid")?.scrollTop || 0;
        list.innerHTML = html;
        // Year grid re-renders from January: keep the reader's place across
        // re-renders (resize, filter), and on "Today" bring the current month up.
        if (calView === "year") {
          const grid = list.querySelector(".cal-year-grid");
          if (calScrollToToday) {
            calScrollToToday = false;
            grid
              ?.querySelector(".cal-mini-day.today")
              ?.closest(".cal-mini")
              ?.scrollIntoView({ block: "start" });
          } else if (grid && prevYearScroll) grid.scrollTop = prevYearScroll;
        }
      }

      function calMonthHTML(dated, listHeight) {
        const todayStr = today();
        const startDow = new Date(calYear, calMonth, 1).getDay(); // 0=Sun
        // Height-aware chip capacity: each of the 6 week rows gets an equal share
        // of the grid, so compute how many 22px chips fit under the day number
        // (28px) per row. Bar lanes and the "+N more" line are subtracted per week.
        // Constants measured from the live DOM (1400x1000): list padding + calendar
        // header + weekday row = 102px of chrome above the 6 week rows.
        const rowH = Math.max(78, ((listHeight || 560) - 102) / 6);

        // 6 fixed week rows, with leading/trailing days from adjacent months
        const weeks = [];
        for (let w = 0; w < 6; w++) {
          const days = [];
          for (let d = 0; d < 7; d++) {
            const dt = new Date(calYear, calMonth, 1 - startDow + w * 7 + d);
            days.push({
              m: dt.getMonth(),
              d: dt.getDate(),
              ds: calDateStr(dt.getFullYear(), dt.getMonth(), dt.getDate()),
            });
          }
          weeks.push(days);
        }

        const multi = dated
          .filter((e) => e.deadlineEnd && e.deadlineEnd > e.deadline)
          .sort(
            (a, b) =>
              a.deadline.localeCompare(b.deadline) ||
              (b.deadlineEnd || "").localeCompare(a.deadlineEnd || ""),
          );
        const singlesByDay = {};
        dated
          .filter((e) => !e.deadlineEnd || e.deadlineEnd <= e.deadline)
          .forEach((e) => {
            (singlesByDay[e.deadline] = singlesByDay[e.deadline] || []).push(e);
          });
        // All-day bands first (GCal order), then timed items chronologically
        Object.values(singlesByDay).forEach((arr) =>
          arr.sort(
            (a, b) =>
              (a.time ? 1 : 0) - (b.time ? 1 : 0) ||
              (a.time || "").localeCompare(b.time || ""),
          ),
        );

        let html = `<div class="cal-scroll"><div class="cal-weekdays">${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => `<div>${d}</div>`).join("")}</div><div class="cal-grid">`;

        weeks.forEach((days) => {
          const weekStart = days[0].ds,
            weekEnd = days[6].ds;
          // Multi-day bars overlapping this week, stacked into lanes greedily
          const lanes = [];
          const bars = [];
          multi
            .filter((e) => e.deadline <= weekEnd && e.deadlineEnd >= weekStart)
            .forEach((e) => {
              const s =
                e.deadline < weekStart
                  ? 0
                  : days.findIndex((x) => x.ds === e.deadline);
              const en =
                e.deadlineEnd > weekEnd
                  ? 6
                  : days.findIndex((x) => x.ds === e.deadlineEnd);
              if (s === -1 || en === -1) return;
              let lane = 0;
              while (
                lanes[lane] &&
                lanes[lane].some((iv) => !(en < iv.s || s > iv.e))
              )
                lane++;
              (lanes[lane] = lanes[lane] || []).push({ s, e: en });
              bars.push({
                e,
                s,
                en,
                lane,
                contL: e.deadline < weekStart,
                contR: e.deadlineEnd > weekEnd,
              });
            });
          // Per-day bar clearance: only days a bar actually spans need padding
          // for it, so an unaffected day in the same row keeps its full chip
          // capacity instead of losing space to a bar drawn over its neighbours.
          const dayBarArea = days.map(
            (_, i) => bars.filter((b) => b.s <= i && b.en >= i).length * 24,
          );

          // Chips that fit below the day number and that day's own bar lanes;
          // when not everything fits, one chip slot is traded for the "+N more"
          // line. Cell = padding-top 28 (+ that day's bar lanes) + chips +
          // padding-bottom 4 + 1px border; each chip is 20.5px with a 2px flex
          // gap (stride 22.5, no gap after the last). Undercounting these
          // clipped the last chip on tall windows.
          const fitAllForDay = (barAreaForDay) =>
            Math.max(0, Math.floor((rowH - 33 - barAreaForDay + 2) / 22.5));
          html +=
            `<div class="cal-week"><div class="cal-week-days">` +
            days
              .map((day, i) => {
                const other = day.m !== calMonth;
                const daySingles = singlesByDay[day.ds] || [];
                const fitAll = fitAllForDay(dayBarArea[i]);
                const maxChips =
                  daySingles.length <= fitAll
                    ? fitAll
                    : Math.max(0, fitAll - 1);
                const chips = daySingles.slice(0, maxChips);
                const more = daySingles.length - chips.length;
                return `<div class="cal-day${other ? " other-month" : ""}" role="button" tabindex="0" aria-label="${fmtDate(day.ds)}" onclick="calDayClick('${day.ds}')" style="padding-top:${28 + dayBarArea[i]}px;">
          <span class="cal-day-num${day.ds === todayStr ? " today" : ""}" role="button" tabindex="0" onclick="event.stopPropagation();openCalDay('${day.ds}')" title="Show everything on this day">${day.d}</span>
          ${chips.map(calChipHTML).join("")}
          ${more > 0 ? `<span class="cal-more" role="button" tabindex="0" onclick="event.stopPropagation();openCalDay('${day.ds}')">+${more} more</span>` : ""}
        </div>`;
              })
              .join("") +
            `</div><div class="cal-week-bars">` +
            bars
              .map((b) => {
                const color = typeColors[b.e.type] || null;
                const bg = color || "var(--accent)";
                const fg = color ? calTextOn(color) : "var(--accent-text)";
                const arch = calArchIdSet.has(b.e.id);
                return `<div class="cal-bar${b.contL ? " cont-l" : ""}${b.contR ? " cont-r" : ""}${arch ? " arch" : ""}" role="button" tabindex="0" onclick="openCalEntry(${b.e.id})" title="${esc(b.e.name)}" style="left:calc(${b.s}/7*100% + 3px);width:calc(${b.en - b.s + 1}/7*100% - 6px);top:${28 + b.lane * 24}px;background:${esc(bg)};color:${fg};">${esc(b.e.name)}</div>`;
              })
              .join("") +
            `</div></div>`;
        });

        html += `</div></div>`;
        return html;
      }

      // GCal-style year overview: 12 mini months, days with entries get a solid
      // circle in the colour of their highest-ranked type (the user's arranged
      // type order decides which type wins when a day has several).
      function calYearHTML(dated) {
        const orderIdx = {};
        allTypes().forEach((t, i) => (orderIdx[t] = i));
        const dayType = {}; // ds -> {idx, color}
        const yearStart = new Date(calYear, 0, 1);
        const yearEnd = new Date(calYear, 11, 31);
        dated.forEach((e) => {
          const color = typeColors[e.type] || null;
          const idx = e.type in orderIdx ? orderIdx[e.type] : 999;
          const endDs =
            e.deadlineEnd && e.deadlineEnd > e.deadline
              ? e.deadlineEnd
              : e.deadline;
          let d = new Date(e.deadline + "T00:00");
          if (d < yearStart) d = new Date(yearStart);
          let stop = new Date(endDs + "T00:00");
          if (stop > yearEnd) stop = new Date(yearEnd);
          for (; d <= stop; d.setDate(d.getDate() + 1)) {
            const ds = calDateStr(d.getFullYear(), d.getMonth(), d.getDate());
            if (!dayType[ds] || idx < dayType[ds].idx)
              dayType[ds] = { idx, color };
          }
        });

        const todayStr = today();
        let out = '<div class="cal-year-grid">';
        for (let m = 0; m < 12; m++) {
          out += `<div class="cal-mini">
      <div class="cal-mini-name" role="button" tabindex="0" onclick="calOpenMonth(${m})" title="Open ${CAL_MONTHS[m]}">${CAL_MONTHS[m]}</div>
      <div class="cal-mini-head">${["S", "M", "T", "W", "T", "F", "S"].map((c) => `<div>${c}</div>`).join("")}</div>
      <div class="cal-mini-week">`;
          const startDow = new Date(calYear, m, 1).getDay();
          const dim = new Date(calYear, m + 1, 0).getDate();
          for (let i = 0; i < startDow; i++)
            out += '<div class="cal-mini-day other">0</div>';
          for (let d = 1; d <= dim; d++) {
            const ds = calDateStr(calYear, m, d);
            const t = dayType[ds];
            const style = t
              ? t.color
                ? ` style="background:${esc(t.color)};color:${calTextOn(t.color)};"`
                : ` style="background:var(--accent);color:var(--accent-text);"`
              : "";
            out += `<div class="cal-mini-day${ds === todayStr ? " today" : ""}" role="button" tabindex="0"${style} onclick="calOpenDayFromYear('${ds}')" title="${fmtDate(ds)}">${d}</div>`;
          }
          out += `</div></div>`;
        }
        out += "</div>";
        return out;
      }

      // Click on an empty part of a day cell → quick-add popup for that date
      let calQuickAddMode = "event";
      function calDayClick(ds) {
        calQuickAddMode = "event";
        document.getElementById("qa-name").value = "";
        document.getElementById("qa-type").innerHTML =
          '<option value="">— type —</option>' +
          allTypes()
            .map((t) => `<option>${esc(t)}</option>`)
            .join("");
        document.getElementById("qa-date").value = ds;
        document.getElementById("qa-date-end").value = "";
        document.getElementById("qa-time").value = "";
        document.getElementById("qa-time-to").value = "";
        document.getElementById("qa-remark").value = "";
        setQuickAddMode("event");
        document.getElementById("qa-title").textContent =
          "New entry — " + fmtDate(ds);
        document.getElementById("cal-quickadd-modal").classList.add("open");
        setTimeout(() => document.getElementById("qa-name").focus(), 50);
      }
      function setQuickAddMode(mode) {
        calQuickAddMode = mode;
        document
          .getElementById("qa-mode-event")
          .classList.toggle("active", mode === "event");
        document
          .getElementById("qa-mode-task")
          .classList.toggle("active", mode === "task");
        document.getElementById("qa-end-wrap").style.display =
          mode === "event" ? "" : "none";
        document.getElementById("qa-date-label").textContent =
          mode === "task" ? "Due date" : "Start date";
      }
      function closeCalQuickAdd() {
        document.getElementById("cal-quickadd-modal").classList.remove("open");
      }
      function calQuickAddSubmit() {
        const name = document.getElementById("qa-name").value.trim();
        if (!name) {
          fieldError("qa-name", "Name cannot be empty.");
          return;
        }
        const isTask = calQuickAddMode === "task";
        const type = document.getElementById("qa-type").value;
        const now = new Date().toISOString();
        const entry = {
          id: Date.now(),
          name,
          type,
          deadline: document.getElementById("qa-date").value || "",
          deadlineEnd: isTask
            ? ""
            : document.getElementById("qa-date-end").value || "",
          time: padHM(document.getElementById("qa-time").value),
          timeTo: padHM(document.getElementById("qa-time-to").value),
          remark: document.getElementById("qa-remark").value.trim(),
          color: typeColors[type] || null,
          gcalColorId: typeGCalIds[type] || undefined,
          syncMode: isTask ? "task" : "event",
          createdAt: now,
          updatedAt: now,
          updated: now,
        };
        closeCalQuickAdd();
        commitNewEntry(entry); // sidebar form and any draft in it stay untouched
      }

      function openCalDay(ds) {
        const items = calDayEntries(ds);
        document.getElementById("cal-day-title").textContent = fmtDate(ds);
        document.getElementById("cal-day-body").innerHTML = items.length
          ? items
              .map((e) => {
                const color = typeColors[e.type] || "var(--border2)";
                const arch =
                  calArchIdSet.has(e.id) || archived.some((a) => a.id === e.id);
                const t = e.time
                  ? `<span class="cal-day-item-time">${fmtTime(e.time)}${e.timeTo ? "–" + fmtTime(e.timeTo) : ""}</span>`
                  : "";
                return `<div class="cal-day-item${arch ? " arch" : ""}" role="button" tabindex="0" onclick="closeCalDay();openCalEntry(${e.id})"><span class="cal-day-dot" style="background:${esc(color)};"></span><span class="cal-day-item-name">${esc(e.name)}</span>${t}</div>`;
              })
              .join("")
          : '<p style="font-size:13px;color:var(--text3);">Nothing on this day.</p>';
        document.getElementById("cal-day-modal").classList.add("open");
      }
      function closeCalDay() {
        document.getElementById("cal-day-modal").classList.remove("open");
      }

      function openCalEntry(id) {
        const isArch =
          !entries.some((x) => x.id === id) &&
          archived.some((x) => x.id === id);
        const e =
          entries.find((x) => x.id === id) || archived.find((x) => x.id === id);
        if (!e) return;
        calEntryId = id;
        const actions = document.getElementById("cal-entry-actions");
        if (actions) {
          actions.innerHTML = isArch
            ? `<button class="btn" onclick="closeCalEntry()">Close</button>
         <button class="btn btn-primary" onclick="calRestoreEntry()">Restore to active</button>`
            : `<button class="btn" onclick="closeCalEntry()">Close</button>
         <button class="btn" onclick="calArchiveEntry()">Archive</button>
         <button class="btn btn-danger" onclick="calDeleteEntry()">Delete</button>
         <button class="btn btn-primary" onclick="openCalEditModal()">Edit</button>`;
        }
        const color = typeColors[e.type] || null;
        const status = deadlineStatus(e.deadline, e.deadlineEnd);
        const statusTxt =
          isArch || e.completed
            ? ""
            : status === " overdue"
              ? "Overdue"
              : status === " today"
                ? "Due today"
                : status === " soon"
                  ? "Due soon"
                  : status === " in-progress"
                    ? "In progress"
                    : status === " last-day"
                      ? "Last day"
                      : "";
        const dateTxt = e.deadline
          ? e.deadlineEnd && e.deadlineEnd > e.deadline
            ? fmtDate(e.deadline) + " → " + fmtDate(e.deadlineEnd)
            : fmtDate(e.deadline)
          : "No date";
        const timeTxt = e.time
          ? fmtTime(e.time) + (e.timeTo ? " → " + fmtTime(e.timeTo) : "")
          : "";
        const remarkLong =
          e.remark &&
          (e.remark.length > 140 || e.remark.split("\n").length > 2);
        document.getElementById("cal-entry-body").innerHTML = `
    <h2 style="margin-bottom:10px;">${esc(e.name)}</h2>
    <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px;">
      ${e.type ? `<span class="chip type"${color ? ` style="background:${esc(color)}22;color:${esc(color)};border-color:${esc(color)}55;"` : ""}>${esc(e.type)}</span>` : ""}
      <span class="chip">${e.syncMode === "task" ? "Task" : "Event"}</span>
      ${isArch ? `<span class="chip" style="color:var(--text3);">Archived</span>` : ""}
      ${e.syncMode === "task" && e.completed ? `<span class="chip" style="color:var(--success);border-color:var(--success);">Done</span>` : ""}
      ${statusTxt ? `<span class="chip" style="color:var(--danger);border-color:var(--danger);">${statusTxt}</span>` : ""}
    </div>
    <p style="font-size:13px;margin-bottom:6px;"><b>${dateTxt}</b>${timeTxt ? " · " + timeTxt : ""}</p>
    ${e.remark ? `<p id="cal-entry-remark" class="cal-remark-clamp" style="font-size:13px;color:var(--text2);white-space:pre-wrap;margin-bottom:4px;">${esc(e.remark)}</p>${remarkLong ? `<button class="cal-remark-more" id="cal-remark-more-btn" onclick="toggleCalRemark()">Show more</button>` : ""}` : ""}`;
        document.getElementById("cal-entry-modal").classList.add("open");
      }
      function toggleCalRemark() {
        const p = document.getElementById("cal-entry-remark");
        const btn = document.getElementById("cal-remark-more-btn");
        if (!p || !btn) return;
        const clamped = p.classList.toggle("cal-remark-clamp");
        btn.textContent = clamped ? "Show more" : "Show less";
      }
      function closeCalEntry() {
        document.getElementById("cal-entry-modal").classList.remove("open");
      }

      // In-place edit modal — same field ids the inline edit card uses, so
      // saveEdit(id) works unchanged (including the Event/Task switch guard).
      function openCalEditModal() {
        const id = calEntryId;
        const e = entries.find((x) => x.id === id);
        if (!e) return;
        closeCalEntry();
        const isTaskEntry = e.syncMode === "task";
        const typeOpts = allTypes()
          .map(
            (t) =>
              `<option${e.type === t ? " selected" : ""}>${esc(t)}</option>`,
          )
          .join("");
        document.getElementById("cal-edit-body").innerHTML = `
    <h2 style="margin-bottom:12px;">Edit entry</h2>
    <div class="edit-fields" style="margin-top:0;padding-top:0;border-top:none;">
      <div><label class="field-label">Work name</label><input type="text" id="edit-name-${e.id}" value="${esc(e.name)}"/></div>
      <div class="sync-mode-toggle" style="margin-bottom:0;">
        <button class="sync-mode-btn${isTaskEntry ? "" : " active"}" id="edit-mode-event-${e.id}" onclick="setEditSyncMode(${e.id},'event')">Event</button>
        <button class="sync-mode-btn${isTaskEntry ? " active" : ""}" id="edit-mode-task-${e.id}" onclick="setEditSyncMode(${e.id},'task')">Task</button>
      </div>
      <input type="hidden" id="edit-syncmode-${e.id}" value="${isTaskEntry ? "task" : "event"}"/>
      <div class="edit-row2">
        <div><label class="field-label">Type</label>
          <select id="edit-type-${e.id}"><option value="">— type —</option>${typeOpts}</select>
        </div>
        <div id="edit-dates-task-${e.id}" style="grid-column:span 2;display:${isTaskEntry ? "block" : "none"};"><label class="field-label">Due date</label><input type="date" id="edit-deadline-task-${e.id}" value="${e.deadline || ""}"/></div>
        <div id="edit-dates-event-${e.id}" style="display:${isTaskEntry ? "none" : "contents"};">
          <div><label class="field-label">Start date</label><input type="date" id="edit-deadline-${e.id}" value="${e.deadline || ""}"/></div>
          <div><label class="field-label">End date</label><input type="date" id="edit-deadline-end-${e.id}" value="${e.deadlineEnd || ""}" title="Leave blank for single day"/></div>
        </div>
      </div>
      <div><label class="field-label">Time<span id="edit-time-label-note-${e.id}">${isTaskEntry ? " (shown in task title)" : ""}</span></label><div style="display:flex;gap:6px;align-items:center;"><input type="time" id="edit-time-${e.id}" value="${e.time || ""}" style="flex:1;"/><span style="font-size:12px;color:var(--text3);">→</span><input type="time" id="edit-time-to-${e.id}" value="${e.timeTo || ""}" style="flex:1;"/></div></div>
      <div><label class="field-label">Remark</label><textarea id="edit-remark-${e.id}" style="min-height:70px;">${esc(e.remark || "")}</textarea></div>
    </div>`;
        document.getElementById("cal-edit-modal").classList.add("open");
      }
      function closeCalEditModal() {
        document.getElementById("cal-edit-modal").classList.remove("open");
      }
      async function calSaveEditModal() {
        // Close only on a successful save — validation failures (empty name) and
        // the mode-switch warning both keep the modal open with the edits intact.
        const saved = await saveEdit(calEntryId);
        if (saved) closeCalEditModal();
      }
      function calArchiveEntry() {
        const id = calEntryId;
        closeCalEntry();
        archiveEntry(id);
      }
      function calDeleteEntry() {
        const id = calEntryId;
        closeCalEntry();
        deleteEntry(id);
      }
      function calRestoreEntry() {
        const id = calEntryId;
        closeCalEntry();
        restoreEntry(id);
      }

      document
        .getElementById("cal-day-modal")
        ?.addEventListener("click", (ev) => {
          if (ev.target.id === "cal-day-modal") closeCalDay();
        });
      document
        .getElementById("cal-entry-modal")
        ?.addEventListener("click", (ev) => {
          if (ev.target.id === "cal-entry-modal") closeCalEntry();
        });
      document
        .getElementById("cal-quickadd-modal")
        ?.addEventListener("click", (ev) => {
          if (ev.target.id === "cal-quickadd-modal") closeCalQuickAdd();
        });
      // No click-outside-to-close on cal-edit-modal (v1.9.1) — an edit in
      // progress should only close via Cancel/Save/Escape, not a stray click.

      // Re-fit the calendar's chip capacity when the window size changes — without
      // this, growing the window leaves stale "+N more" and shrinking silently
      // clips chips (the cells use overflow:hidden).
      // Keyboard activation for the calendar's role="button" divs/spans (day
      // cells, chips, "+N more", mini-year days, day-popover rows): Enter or
      // Space fires their onclick, exactly as a native button would.
      document.addEventListener("keydown", (e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        const t = e.target;
        if (
          !(t instanceof HTMLElement) ||
          t.getAttribute("role") !== "button" ||
          t.tagName === "BUTTON" ||
          t.tagName === "INPUT"
        )
          return;
        e.preventDefault();
        t.click();
      });
      let calResizeTimer = null;
      window.addEventListener("resize", () => {
        if (viewLayout !== "calendar" || viewMode !== "active") return;
        clearTimeout(calResizeTimer);
        calResizeTimer = setTimeout(() => render(), 200);
      });
      function toggleFilterType(t) {
        if (t === "All") {
          selectedFilterTypes = [];
        } else if (selectedFilterTypes.includes(t)) {
          selectedFilterTypes = selectedFilterTypes.filter((x) => x !== t);
        } else {
          selectedFilterTypes = [...selectedFilterTypes, t];
        }
        render();
      }
      function setSortAndRender(v) {
        sortMode = v;
        pinnedId = null;
        render();
      }

      let searchDebounceTimer = null;
      function setSearch(q) {
        clearTimeout(searchDebounceTimer);
        searchDebounceTimer = setTimeout(() => {
          searchQuery = q;
          render();
        }, 180);
      }

      const SEARCH_MONTH_NAMES = [
        "january",
        "february",
        "march",
        "april",
        "may",
        "june",
        "july",
        "august",
        "september",
        "october",
        "november",
        "december",
      ];
      const SEARCH_MONTH_ABBR = [
        "jan",
        "feb",
        "mar",
        "apr",
        "may",
        "jun",
        "jul",
        "aug",
        "sep",
        "oct",
        "nov",
        "dec",
      ];

      // Build a blob of every human-readable way this date could be written, so a
      // search for "July 2", "02/07", "2/7/2026", or the raw "2026-07-02" all match.
      function dateSearchBlob(dateStr) {
        if (!dateStr) return "";
        const [y, m, day] = dateStr.split("-");
        const mi = +m - 1;
        const dayNum = parseInt(day, 10);
        const mon = +m;
        return [
          dateStr,
          `${day}/${m}/${y}`,
          `${dayNum}/${mon}/${y}`,
          SEARCH_MONTH_NAMES[mi],
          SEARCH_MONTH_ABBR[mi],
          `${SEARCH_MONTH_ABBR[mi]} ${dayNum}`,
          `${SEARCH_MONTH_NAMES[mi]} ${dayNum}`,
          `${dayNum} ${SEARCH_MONTH_ABBR[mi]}`,
          `${dayNum} ${SEARCH_MONTH_NAMES[mi]}`,
          y,
        ].join(" ");
      }

      // Build a blob of both 24h ("13:30") and 12h ("1:30PM" / "1:30 PM") forms.
      function timeSearchBlob(timeStr) {
        if (!timeStr) return "";
        const t12 = fmtTime(timeStr);
        return `${timeStr} ${t12} ${t12.replace(/(AM|PM)/, " $1")}`.toLowerCase();
      }

      function matchesSearch(e, q) {
        if (!q) return true;
        const lq = q.toLowerCase().trim();
        if (e.name.toLowerCase().includes(lq)) return true;
        const dateBlob = (
          dateSearchBlob(e.deadline) +
          " " +
          dateSearchBlob(e.deadlineEnd)
        ).toLowerCase();
        if (dateBlob.includes(lq)) return true;
        const timeBlob =
          timeSearchBlob(e.time) + " " + timeSearchBlob(e.timeTo);
        if (timeBlob.includes(lq)) return true;
        return false;
      }

      function highlight(text, query) {
        if (!query) return esc(text);
        const str = String(text || "");
        const lq = query.toLowerCase();
        const lt = str.toLowerCase();
        const idx = lt.indexOf(lq);
        if (idx === -1) return esc(str);
        return (
          esc(str.slice(0, idx)) +
          "<strong>" +
          esc(str.slice(idx, idx + query.length)) +
          "</strong>" +
          highlight(str.slice(idx + query.length), query)
        );
      }

      // ── Icons ──────────────────────────────────────────────────────────────────
      function editIcon() {
        return `<svg class="icon sm" viewBox="0 0 24 24"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`;
      }
      function trashIcon() {
        return `<svg class="icon sm" viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/></svg>`;
      }
      function trashForeverIcon() {
        return `<svg class="icon sm" viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M9 6V4h6v2"/><line x1="9.5" y1="11.5" x2="14.5" y2="16.5"/><line x1="14.5" y1="11.5" x2="9.5" y2="16.5"/></svg>`;
      }
      function archiveIcon() {
        return `<svg class="icon sm" viewBox="0 0 24 24"><polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/><line x1="10" y1="12" x2="14" y2="12"/></svg>`;
      }
      function restoreIcon() {
        return `<svg class="icon sm" viewBox="0 0 24 24"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-4"/></svg>`;
      }
      function calIcon() {
        return `<svg class="icon sm" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>`;
      }
      function taskSyncIcon() {
        return `<svg class="icon sm" viewBox="0 0 24 24"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>`;
      }

      // ── Export ─────────────────────────────────────────────────────────────────
      // Shift a UTC ISO timestamp by +7h and read it back with getUTC* methods,
      // so the result is GMT+7 wall-clock time regardless of the viewer's local timezone.
      function toGMT7(isoStr) {
        const utc = new Date(isoStr);
        return new Date(utc.getTime() + 7 * 60 * 60 * 1000);
      }
      function formatDateGMT7(isoStr) {
        if (!isoStr) return "";
        const d = toGMT7(isoStr);
        const day = String(d.getUTCDate()).padStart(2, "0");
        const mon = String(d.getUTCMonth() + 1).padStart(2, "0");
        const yr = d.getUTCFullYear();
        return `${day}/${mon}/${yr}`;
      }
      function formatTimeGMT7(isoStr) {
        if (!isoStr) return "";
        const d = toGMT7(isoStr);
        const h = String(d.getUTCHours()).padStart(2, "0");
        const m = String(d.getUTCMinutes()).padStart(2, "0");
        const s = String(d.getUTCSeconds()).padStart(2, "0");
        return `${h}:${m}:${s}`;
      }
      function formatUpdatedGMT7(isoStr) {
        if (!isoStr) return "";
        return `${formatDateGMT7(isoStr)} , ${formatTimeGMT7(isoStr)}`;
      }
      function formatDeadlineDMY(dateStr) {
        if (!dateStr) return "";
        const [y, m, d] = dateStr.split("-");
        return `${d}/${m}/${y}`;
      }

      function exportRow(e) {
        const timeStr = e.time
          ? e.timeTo
            ? `${e.time} - ${e.timeTo}`
            : e.time
          : "";
        const created = e.createdAt || e.created;
        const updated = e.updatedAt || e.updated;
        return {
          id: String(e.id || ""),
          name: e.name,
          type: e.type || "",
          deadline: formatDeadlineDMY(e.deadline),
          time: timeStr,
          remark: e.remark || "",
          created: formatDateGMT7(created),
          timeCreated: formatTimeGMT7(created),
          updated: formatUpdatedGMT7(updated),
        };
      }

      function exportCSV(source = entries, filename = "worklog.csv") {
        if (!source.length) {
          toast("Nothing to export.");
          return;
        }
        const rows = [
          [
            "ID",
            "Name",
            "Type",
            "Deadline",
            "Time",
            "Remark",
            "Date Created",
            "Time Created",
            "Updated",
          ],
          ...source.map((e) => {
            const r = exportRow(e);
            return [
              '="' + r.id + '"',
              r.name,
              r.type,
              r.deadline,
              r.time,
              r.remark,
              r.created,
              r.timeCreated,
              r.updated,
            ];
          }),
        ];
        const csv = rows
          .map((r) =>
            r.map((c) => '"' + String(c).replace(/"/g, '""') + '"').join(","),
          )
          .join("\n");
        dl(
          filename,
          "data:text/csv;charset=utf-8," + encodeURIComponent("﻿" + csv),
        );
      }
      function exportJSON(source = entries, filename = "worklog.json") {
        if (!source.length) {
          toast("Nothing to export.");
          return;
        }
        const sanitized = source.map((e) => ({
          ...e,
          created: e.created?.replace("Z", " UTC"),
          updated: e.updated?.replace("Z", " UTC"),
        }));
        dl(
          filename,
          "data:application/json;charset=utf-8," +
            encodeURIComponent(JSON.stringify(sanitized, null, 2)),
        );
      }
      async function exportXLSX(
        source = entries,
        filename = "worklog.xlsx",
        sheetName = "Work Log",
      ) {
        if (typeof ExcelJS === "undefined") {
          toast("Excel library not loaded yet, try again.");
          return;
        }
        if (!source.length) {
          toast("Nothing to export.");
          return;
        }
        const wb = new ExcelJS.Workbook();
        const ws = wb.addWorksheet(sheetName);
        ws.columns = [
          { header: "ID", key: "id", width: 16 },
          { header: "Name", key: "name", width: 30 },
          { header: "Type", key: "type", width: 12 },
          { header: "Deadline", key: "deadline", width: 14 },
          { header: "Time", key: "time", width: 14 },
          { header: "Remark", key: "remark", width: 40 },
          { header: "Date Created", key: "created", width: 14 },
          { header: "Time Created", key: "timeCreated", width: 14 },
          { header: "Updated", key: "updated", width: 22 },
        ];
        source.forEach((e) => ws.addRow(exportRow(e)));

        ws.autoFilter = {
          from: "A1",
          to: { row: 1, column: ws.columns.length },
        };

        const headerRow = ws.getRow(1);
        headerRow.eachCell((cell, colNumber) => {
          cell.fill = {
            type: "pattern",
            pattern: "solid",
            fgColor: { argb: "FF60497A" },
          };
          cell.font = { color: { argb: "FFFFFFFF" }, bold: true };
          if (colNumber >= 3 && colNumber <= 5)
            cell.alignment = { horizontal: "center" };
          if (colNumber >= 7 && colNumber <= 9)
            cell.alignment = { horizontal: "right" };
        });

        for (let i = 2; i <= ws.rowCount; i++) {
          const row = ws.getRow(i);
          const bg = i % 2 === 0 ? "FFE4DFEC" : "FFCCC0DA";
          row.eachCell((cell, colNumber) => {
            cell.fill = {
              type: "pattern",
              pattern: "solid",
              fgColor: { argb: bg },
            };
            if (colNumber >= 3 && colNumber <= 5)
              cell.alignment = { horizontal: "center" };
            if (colNumber >= 7 && colNumber <= 9)
              cell.alignment = { horizontal: "right" };
          });
        }

        const buffer = await wb.xlsx.writeBuffer();
        const blob = new Blob([buffer], { type: "application/octet-stream" });
        const url = URL.createObjectURL(blob);
        dl(filename, url);
        setTimeout(() => URL.revokeObjectURL(url), 2000);
      }
      function exportArchiveCSV() {
        exportCSV(archived, "worklog-archive.csv");
      }
      function exportArchiveXLSX() {
        return exportXLSX(archived, "worklog-archive.xlsx", "Archive");
      }
      function exportArchiveJSON() {
        exportJSON(archived, "worklog-archive.json");
      }
      function dl(name, href) {
        const a = document.createElement("a");
        a.href = href;
        a.download = name;
        a.click();
      }

      // ── Import ─────────────────────────────────────────────────────────────────
      function handleImportFile(file) {
        if (!file) return;
        const ext = file.name.split(".").pop().toLowerCase();
        const input = document.getElementById("import-file-input");
        if (ext === "json") {
          const reader = new FileReader();
          reader.onload = () =>
            finishImport(parseImportJSON(reader.result), "JSON");
          reader.onerror = () => toast("Could not read file.");
          reader.readAsText(file);
        } else if (ext === "csv") {
          const reader = new FileReader();
          reader.onload = () =>
            finishImport(parseImportCSV(reader.result), "CSV");
          reader.onerror = () => toast("Could not read file.");
          reader.readAsText(file);
        } else if (ext === "xlsx") {
          parseImportXLSX(file)
            .then((rows) => finishImport(rows, "Excel"))
            .catch(() => toast("Could not read Excel file."));
        } else {
          toast("Unsupported file type. Use .json, .csv, or .xlsx.");
        }
        if (input) input.value = "";
      }

      // Lossless: raw entry objects from our own JSON export.
      function parseImportJSON(text) {
        let data;
        try {
          data = JSON.parse(text);
        } catch (e) {
          toast("Invalid JSON file.");
          return [];
        }
        if (!Array.isArray(data)) {
          toast("JSON file must contain an array of entries.");
          return [];
        }
        return data
          .filter((e) => e && e.name)
          .map((e) => ({
            id:
              typeof e.id === "number"
                ? e.id
                : typeof e.id === "string" && /^\d+$/.test(e.id)
                  ? parseInt(e.id)
                  : null,
            name: e.name,
            type: e.type || "",
            deadline: e.deadline || "",
            deadlineEnd: e.deadlineEnd || "",
            time: e.time || "",
            timeTo: e.timeTo || "",
            remark: e.remark || "",
            syncMode: e.syncMode === "task" ? "task" : "event",
            color: e.color || null,
            gcalColorId: e.gcalColorId,
          }));
      }

      // Minimal CSV parser handling quoted fields, embedded commas/newlines, "" escapes.
      function parseCSVRows(text) {
        text = text.replace(/^﻿/, "");
        const rows = [];
        let row = [];
        let field = "";
        let inQuotes = false;
        for (let i = 0; i < text.length; i++) {
          const c = text[i];
          if (inQuotes) {
            if (c === '"') {
              if (text[i + 1] === '"') {
                field += '"';
                i++;
              } else inQuotes = false;
            } else field += c;
          } else {
            if (c === '"') inQuotes = true;
            else if (c === ",") {
              row.push(field);
              field = "";
            } else if (c === "\n") {
              row.push(field);
              rows.push(row);
              row = [];
              field = "";
            } else if (c === "\r") {
              /* skip */
            } else field += c;
          }
        }
        if (field !== "" || row.length) {
          row.push(field);
          rows.push(row);
        }
        return rows.filter((r) => r.length > 1 || r[0] !== "");
      }

      // dd/mm/yyyy -> yyyy-mm-dd
      function parseImportDate(s) {
        const m = String(s || "")
          .trim()
          .match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
        if (!m) return "";
        return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
      }
      // "HH:MM" or "HH:MM - HH:MM" -> {time, timeTo}
      function parseImportTime(s) {
        const parts = String(s || "")
          .split("-")
          .map((x) => x.trim())
          .filter(Boolean);
        return { time: padHM(parts[0]), timeTo: padHM(parts[1]) };
      }

      // Best-effort: CSV export drops deadlineEnd/syncMode/color, so those come back empty.
      function parseImportCSV(text) {
        const rows = parseCSVRows(text);
        if (rows.length < 2) {
          toast("CSV file has no data rows.");
          return [];
        }
        const header = rows[0].map((h) => h.trim().toLowerCase());
        const idx = {
          id: header.indexOf("id"),
          name: header.indexOf("name"),
          type: header.indexOf("type"),
          deadline: header.indexOf("deadline"),
          time: header.indexOf("time"),
          remark: header.indexOf("remark"),
        };
        if (idx.name === -1) {
          toast('CSV missing a "Name" column.');
          return [];
        }
        return rows
          .slice(1)
          .filter((r) => r[idx.name])
          .map((r) => {
            const { time, timeTo } = parseImportTime(
              idx.time > -1 ? r[idx.time] : "",
            );
            const rawId =
              idx.id > -1 ? (r[idx.id] || "").replace(/^="?|"$/g, "") : "";
            return {
              id: /^\d+$/.test(rawId) ? parseInt(rawId) : null,
              name: r[idx.name],
              type: idx.type > -1 ? r[idx.type] || "" : "",
              deadline: parseImportDate(
                idx.deadline > -1 ? r[idx.deadline] : "",
              ),
              deadlineEnd: "",
              time,
              timeTo,
              remark: idx.remark > -1 ? r[idx.remark] || "" : "",
              syncMode: "event",
              color: null,
            };
          });
      }

      // Best-effort: same field limitations as CSV.
      async function parseImportXLSX(file) {
        if (typeof ExcelJS === "undefined") {
          toast("Excel library not loaded yet, try again.");
          return [];
        }
        const wb = new ExcelJS.Workbook();
        await wb.xlsx.load(await file.arrayBuffer());
        const ws = wb.worksheets[0];
        if (!ws) return [];
        const header = (ws.getRow(1).values || []).map((v) =>
          String(v || "")
            .trim()
            .toLowerCase(),
        );
        const idx = {
          id: header.indexOf("id"),
          name: header.indexOf("name"),
          type: header.indexOf("type"),
          deadline: header.indexOf("deadline"),
          time: header.indexOf("time"),
          remark: header.indexOf("remark"),
        };
        if (idx.name === -1) {
          toast('Excel file missing a "Name" column.');
          return [];
        }
        const out = [];
        ws.eachRow((row, rowNum) => {
          if (rowNum === 1) return;
          const v = row.values;
          const name = v[idx.name];
          if (!name) return;
          const { time, timeTo } = parseImportTime(
            idx.time > -1 ? v[idx.time] : "",
          );
          const rawId = idx.id > -1 ? String(v[idx.id] || "") : "";
          out.push({
            id: /^\d+$/.test(rawId) ? parseInt(rawId) : null,
            name: String(name),
            type: idx.type > -1 ? String(v[idx.type] || "") : "",
            deadline: parseImportDate(idx.deadline > -1 ? v[idx.deadline] : ""),
            deadlineEnd: "",
            time,
            timeTo,
            remark: idx.remark > -1 ? String(v[idx.remark] || "") : "",
            syncMode: "event",
            color: null,
          });
        });
        return out;
      }

      // name+deadline+time signature — used to catch duplicates from sources with no id (CSV/XLSX)
      // and as a fallback if an id happens not to match.
      function importSig(e) {
        return (
          (e.name || "").trim().toLowerCase() +
          "|" +
          (e.deadline || "") +
          "|" +
          (e.time || "")
        );
      }

      function finishImport(list, label) {
        if (!list.length) {
          return;
        }
        const existingIds = new Set(
          entries.map((e) => e.id).concat(archived.map((e) => e.id)),
        );
        const existingSigs = new Set(
          entries.map(importSig).concat(archived.map(importSig)),
        );
        const now = new Date().toISOString();
        let added = 0,
          skipped = 0;
        list.forEach((e, i) => {
          const isDup =
            (e.id && existingIds.has(e.id)) || existingSigs.has(importSig(e));
          if (isDup) {
            skipped++;
            return;
          }
          const type = e.type || "";
          const id = Date.now() + i;
          entries.unshift({
            id,
            name: e.name,
            type,
            deadline: e.deadline || "",
            deadlineEnd: e.deadlineEnd || "",
            time: e.time || "",
            timeTo: e.timeTo || "",
            remark: e.remark || "",
            color: e.color || typeColors[type] || null,
            gcalColorId: e.gcalColorId || typeGCalIds[type] || undefined,
            syncMode: e.syncMode === "task" ? "task" : "event",
            createdAt: now,
            updatedAt: now,
          });
          existingIds.add(id);
          existingSigs.add(importSig(e));
          added++;
        });
        save();
        render();
        if (added && skipped)
          toast(
            `Imported ${added} ${label} ${added === 1 ? "entry" : "entries"}, skipped ${skipped} duplicate${skipped === 1 ? "" : "s"}.`,
            3500,
          );
        else if (added)
          toast(
            `Imported ${added} ${label} ${added === 1 ? "entry" : "entries"}.`,
          );
        else toast(`No new entries — all ${skipped} already exist.`, 3500);
      }

      // ── Toast ──────────────────────────────────────────────────────────────────
      let toastHideTimer = null;
      // Inline field validation: red ring + message under the field, cleared on
      // next input. Falls back to a toast if the field is not in the DOM.
      function fieldError(id, msg) {
        const el = document.getElementById(id);
        if (!el) {
          toast(msg);
          return;
        }
        el.classList.add("field-invalid");
        el.setAttribute("aria-invalid", "true");
        let m = el.parentElement.querySelector(".field-error");
        if (!m) {
          m = document.createElement("div");
          m.className = "field-error";
          m.setAttribute("role", "alert");
          el.insertAdjacentElement("afterend", m);
        }
        m.textContent = msg;
        el.focus();
        const clear = () => {
          el.classList.remove("field-invalid");
          el.removeAttribute("aria-invalid");
          m.remove();
        };
        el.addEventListener("input", clear, { once: true });
        el.addEventListener("change", clear, { once: true });
      }
      function toast(msg, dur = 2400) {
        const el = document.getElementById("toast");
        el.textContent = msg;
        el.classList.add("show");
        clearTimeout(toastHideTimer);
        toastHideTimer = setTimeout(() => el.classList.remove("show"), dur);
      }

      // Same as toast() but appends a clickable Undo action that runs undoFn once.
      function toastWithUndo(msg, undoFn, dur = 6000) {
        const el = document.getElementById("toast");
        el.textContent = msg + " ";
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "toast-undo-btn";
        btn.textContent = "Undo";
        btn.onclick = () => {
          clearTimeout(toastHideTimer);
          el.classList.remove("show");
          undoFn();
        };
        el.appendChild(btn);
        el.classList.add("show");
        clearTimeout(toastHideTimer);
        toastHideTimer = setTimeout(() => el.classList.remove("show"), dur);
      }

      // ── Google Calendar ────────────────────────────────────────────────────────
      // Google's OAuth implicit-flow access token expires after ~1 hour with no
      // refresh token, so calls silently start failing (401) while the pill still
      // shows "connected". This flags that state visibly instead of failing silent.
      let gcalExpired = false;
      function checkGCalAuthExpired(res) {
        if (res && res.status === 401 && !gcalExpired) {
          gcalExpired = true;
          const pill = document.getElementById("gcal-pill");
          pill.classList.remove("connected");
          pill.classList.add("expired");
          document.getElementById("gcal-pill-text").textContent =
            "Reconnect Google Calendar";
          // Surface the reconnect modal — but never on top of an in-progress
          // reconnect (openGCalModal would reset the paste box / auth link and
          // swap the buttons mid-flow) or over another modal the user is in.
          // The pill has already turned red in those cases; that's enough.
          const gcalModalOpen = document
            .getElementById("gcal-modal")
            .classList.contains("open");
          const otherModalOpen = !!document.querySelector(
            ".modal-overlay.open:not(#gcal-modal), .settings-overlay.open, .trash-overlay.open, .due-modal-overlay.open",
          );
          if (!gcalModalOpen && !otherModalOpen) openGCalModal();
          else if (!gcalModalOpen)
            toast(
              "Google Calendar session expired — click the pill to reconnect.",
              5000,
            );
        }
      }
      function clearGCalExpired() {
        gcalExpired = false;
        document.getElementById("gcal-pill").classList.remove("expired");
      }

      // A stored token only means we WERE connected — it may have expired since.
      // Make one cheap read-only call on load to confirm it's still actually valid,
      // instead of trusting "a token exists" as proof of a live connection.
      async function verifyGCalToken() {
        if (!gcalToken) return "disconnected";
        try {
          // Must be an endpoint the `calendar.events` scope is allowed to hit.
          // `GET calendars/primary` (calendars.get) needs the broader `calendar` /
          // `calendar.readonly` scope and answered 403 with our token — which made
          // this report 'error' for a perfectly live connection, so the Event/Task
          // switch warned "not connected" no matter how many times you reconnected.
          const res = await fetch(
            "https://www.googleapis.com/calendar/v3/calendars/primary/events?maxResults=1&fields=kind",
            {
              headers: { Authorization: `Bearer ${gcalToken}` },
            },
          );
          checkGCalAuthExpired(res);
          // Only a clean 2xx proves the connection works — 403 (scope), 429, 5xx
          // are all broken states that must not pass a liveness check.
          return res.status === 401 ? "expired" : res.ok ? "ok" : "error";
        } catch {
          // Offline/network hiccup — not proof of expiry, so don't flag the pill,
          // but report it so callers needing a LIVE connection can fail closed.
          return "network";
        }
      }

      function openGCalModal() {
        const connected = !!gcalToken;
        document.getElementById("gcal-modal-title").textContent = connected
          ? "Google Calendar"
          : "Connect Google Calendar";
        document.getElementById("gcal-connected-section").style.display =
          connected ? "block" : "none";
        document.getElementById("gcal-setup-section").style.display = connected
          ? "none"
          : "block";
        document.getElementById("gcal-token-section").style.display = "none";
        const authLinkEl = document.getElementById("gcal-auth-link");
        if (authLinkEl) authLinkEl.style.display = "none";
        if (connected) {
          const statusEl = document.getElementById("gcal-connected-status");
          if (gcalExpired) {
            statusEl.style.color = "var(--danger)";
            statusEl.style.background = "var(--danger-bg)";
            statusEl.innerHTML =
              "<strong>⚠ Your session has expired.</strong> Click Reconnect below to sign in again.";
          } else {
            statusEl.style.color = "var(--success)";
            statusEl.style.background = "var(--success-bg)";
            statusEl.innerHTML =
              "<strong>✓ Google Calendar is connected.</strong> New entries with a deadline sync automatically.";
          }
          document.getElementById("gcal-modal-actions").innerHTML =
            `<button class="btn" onclick="closeGCalModal()">Close</button><button class="btn" onclick="gcalDisconnect()" style="color:var(--danger);">Disconnect</button><button class="btn btn-primary" onclick="gcalAuthorise()">Reconnect</button>`;
          updateSyncStatusUI();
        } else {
          document.getElementById("gcal-client-id").value = gcalClientId;
          document.getElementById("gcal-modal-actions").innerHTML =
            `<button class="btn" onclick="closeGCalModal()">Cancel</button><button class="btn btn-primary" onclick="gcalAuthorise()">Authorise with Google</button>`;
        }
        document.getElementById("gcal-modal").classList.add("open");
      }
      function closeGCalModal() {
        document.getElementById("gcal-modal").classList.remove("open");
      }

      function closeModeSwitchWarn() {
        document
          .getElementById("mode-switch-warn-modal")
          .classList.remove("open");
      }
      document
        .getElementById("mode-switch-warn-modal")
        ?.addEventListener("click", (ev) => {
          if (ev.target.id === "mode-switch-warn-modal") closeModeSwitchWarn();
        });

      function gcalDisconnect() {
        gcalToken = null;
        localStorage.removeItem("wl2dev_gcal_token");
        clearGCalExpired();
        document.getElementById("gcal-pill").classList.remove("connected");
        document.getElementById("gcal-pill-text").textContent =
          "Connect Google Calendar";
        closeGCalModal();
        toast("Google Calendar disconnected.");
      }

      function gcalAuthorise() {
        // When reconnecting from the connected state, the setup section (with the
        // Client ID field) is hidden — fall back to the saved Client ID instead.
        const cidInput = document.getElementById("gcal-client-id");
        const cid =
          (cidInput.offsetParent !== null ? cidInput.value.trim() : "") ||
          gcalClientId;
        if (!cid) {
          toast("Paste your Client ID first.");
          document.getElementById("gcal-setup-section").style.display = "block";
          document.getElementById("gcal-connected-section").style.display =
            "none";
          return;
        }
        gcalClientId = cid;
        localStorage.setItem("wl2dev_gcal_client_id", cid);
        const scope = encodeURIComponent(
          "https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/tasks https://www.googleapis.com/auth/drive.appdata",
        );
        const redirect = encodeURIComponent(
          "https://famelx.github.io/Work-Log/",
        );
        const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${encodeURIComponent(cid)}&redirect_uri=${redirect}&response_type=token&scope=${scope}&prompt=consent`;
        const popup = window.open(
          authUrl,
          "gcal_oauth",
          "width=520,height=620",
        );
        // The popup will auto-send the token back via postMessage; show the manual
        // paste box only as a fallback in case the popup can't reach us.
        document.getElementById("gcal-setup-section").style.display = "block";
        document.getElementById("gcal-connected-section").style.display =
          "none";
        document.getElementById("gcal-token-section").style.display = "block";
        document.getElementById("gcal-modal-actions").innerHTML =
          `<button class="btn" onclick="closeGCalModal()">Cancel</button><button class="btn btn-primary" onclick="gcalSaveToken()">Connect manually</button>`;
        // Mobile browsers (esp. in-app/PWA contexts) frequently block or lose track
        // of window.open popups — `popup` is null when blocked outright, and some
        // browsers open it but sever window.opener so postMessage never arrives.
        // Either way the manual-paste box above is already showing; just tell the
        // user why, with a link they can open directly, instead of leaving them
        // staring at a form with no explanation.
        if (!popup || popup.closed) {
          const linkEl = document.getElementById("gcal-auth-link");
          if (linkEl) {
            linkEl.href = authUrl;
            linkEl.style.display = "inline";
          }
          toast(
            "Pop-up blocked — use the link below to sign in, then paste the token back here.",
            5000,
          );
        }
      }

      function gcalSaveToken() {
        const t = document.getElementById("gcal-token-input").value.trim();
        if (!t) {
          toast("Paste the access_token first.");
          return;
        }
        gcalApplyToken(t);
      }

      // Shared: store the token and flip the UI to connected. Called both by the
      // automatic postMessage capture and by the manual-paste fallback.
      function gcalApplyToken(t) {
        gcalToken = t;
        localStorage.setItem("wl2dev_gcal_token", t);
        clearGCalExpired();
        document.getElementById("gcal-pill").classList.add("connected");
        document.getElementById("gcal-pill-text").textContent =
          "Calendar connected";
        closeGCalModal();
        render();
        toast("Google Calendar connected!");
        gcalColorsFetched = false;
        fetchGCalColors();
        // Cross-device sync FIRST — entries pulled from other devices may already
        // carry gcalEventIds, which keeps the GCal push below from duplicating them.
        setTimeout(async () => {
          // If a sync is already in flight, wait it out — calling performSync now
          // would no-op instantly and the push below would run before the pull,
          // creating duplicate calendar events.
          clearTimeout(syncDebounceTimer);
          for (let i = 0; i < 40 && syncInProgress; i++)
            await new Promise((r) => setTimeout(r, 250));
          let pulled = await performSync();
          if (!pulled) {
            // One retry: most failures here are transient (first-load race, flaky
            // network). If it still fails, say clearly WHY the push is on hold and
            // that the Sync-all button (toolbar) does it manually. Never push blind:
            // without a completed pull we can't know which entries already exist on
            // Google, and pushing would create duplicates.
            await new Promise((r) => setTimeout(r, 1500));
            pulled = await performSync();
          }
          if (!pulled) {
            toast(
              "Cloud sync (Drive) did not finish, so the calendar push is on hold. Check the Drive permission was granted, or use the Sync-all button when ready.",
              6000,
            );
            return;
          }
          // Only push entries that have never been synced — entries with a gcalEventId
          // already exist in GCal and will be PATCHed on next manual save, so skip them
          // to avoid duplicates on reconnect.
          const unsynced = entries.filter(
            (e) => e.deadline && !e.gcalEventId && e.syncMode !== "task",
          );
          const unsyncedTasks = entries.filter(
            (e) => e.deadline && !e.gcalTaskId && e.syncMode === "task",
          );
          const total = unsynced.length + unsyncedTasks.length;
          if (total > 0) {
            toast(
              `Syncing ${total} new ${total === 1 ? "entry" : "entries"} to Google Calendar…`,
              3000,
            );
            for (const e of unsynced) await pushToGCal(e, true);
            for (const e of unsyncedTasks) await pushToGTask(e, true);
            toast(
              `Done! ${total} ${total === 1 ? "entry" : "entries"} synced to Google Calendar.`,
            );
          }
        }, 500);
      }

      async function syncAllToGCal(silent = false) {
        if (!gcalToken) {
          toast("Connect Google Calendar first.");
          return;
        }
        const toSync = entries.filter((e) => e.deadline);
        if (!toSync.length) {
          toast("No entries with deadlines to sync.");
          return;
        }
        if (!silent) toast(`Syncing ${toSync.length} entries…`, 3000);
        let synced = 0;
        for (const e of toSync) {
          if (e.syncMode === "task") await pushToGTask(e, silent);
          else await pushToGCal(e, silent);
          synced++;
        }
        toast(
          `Done! ${synced} ${synced === 1 ? "entry" : "entries"} synced to Google Calendar.`,
        );
      }

      // Normalizes a time string to zero-padded "HH:MM" for the Google API, which
      // rejects e.g. "1:00" (needs "01:00") -- entries can get an unpadded time from
      // the AI Assistant or Import File, which don't enforce the picker's format.
      function padHM(t) {
        const m = String(t || "")
          .trim()
          .match(/^(\d{1,2}):(\d{1,2})$/);
        if (!m) return "";
        const hh = Math.min(23, parseInt(m[1]) || 0);
        const mm = Math.min(59, parseInt(m[2]) || 0);
        return String(hh).padStart(2, "0") + ":" + String(mm).padStart(2, "0");
      }

      function buildGCalEvent(entry) {
        const desc = [
          entry.type ? `Type: ${entry.type}` : "",
          entry.remark || "",
        ]
          .filter(Boolean)
          .join("\n");
        // Always use the current colour mapping for this type, not whatever was
        // frozen on the entry at creation/edit time — so changing a type's GCal
        // colour in Settings takes effect the next time this entry is synced.
        const colorId =
          typeGCalIds[entry.type] || entry.gcalColorId || undefined;
        let start, end;
        const time = padHM(entry.time);
        if (time) {
          const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
          const endDate = entry.deadlineEnd || entry.deadline;
          const endTime = padHM(entry.timeTo) || time;
          start = { dateTime: `${entry.deadline}T${time}:00`, timeZone: tz };
          end = { dateTime: `${endDate}T${endTime}:00`, timeZone: tz };
        } else if (entry.deadlineEnd) {
          // Multi-day all-day event: GCal end date is exclusive, so add 1 day
          const endExclusive = new Date(entry.deadlineEnd);
          endExclusive.setDate(endExclusive.getDate() + 1);
          start = { date: entry.deadline };
          end = { date: endExclusive.toISOString().split("T")[0] };
        } else {
          start = { date: entry.deadline };
          end = { date: entry.deadline };
        }
        return {
          summary: entry.name,
          description: desc,
          start,
          end,
          ...(colorId && { colorId }),
        };
      }

      async function pushToGCal(entry, silent = false) {
        if (!gcalToken || !entry?.deadline) {
          if (!silent) toast("No deadline set.");
          return;
        }
        try {
          // ── If we already have the event ID, PATCH instead of creating a duplicate
          if (entry.gcalEventId) {
            await patchGCal(entry, silent);
            return;
          }
          // ── No ID: create new event ───────────────────────────────────────────
          const res = await fetch(
            "https://www.googleapis.com/calendar/v3/calendars/primary/events",
            {
              method: "POST",
              headers: {
                Authorization: `Bearer ${gcalToken}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify(buildGCalEvent(entry)),
            },
          );
          checkGCalAuthExpired(res);
          if (res.ok) {
            const created = await res.json();
            entry.gcalEventId = created.id;
            // Bump the timestamp: without it the id can lose a merge tie to an
            // id-less copy on another device, which then creates a duplicate event.
            touchEntry(entry);
            save();
            if (!silent) toast(`"${entry.name}" added to Google Calendar.`);
          } else {
            const err = await res.json();
            if (!silent)
              toast(
                "Calendar error — " +
                  (err.error?.message || "token may have expired."),
              );
          }
        } catch (e) {
          if (!silent) toast("Could not reach Google Calendar.");
        }
      }

      async function patchGCal(entry, silent = false) {
        if (!gcalToken || !entry?.gcalEventId) return;
        try {
          const res = await fetch(
            `https://www.googleapis.com/calendar/v3/calendars/primary/events/${entry.gcalEventId}`,
            {
              method: "PATCH",
              headers: {
                Authorization: `Bearer ${gcalToken}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify(buildGCalEvent(entry)),
            },
          );
          checkGCalAuthExpired(res);
          if (res.ok) {
            if (!silent) toast(`Calendar event updated for "${entry.name}".`);
          } else if (res.status === 404) {
            // Event was deleted from GCal manually — clear stale ID and create fresh
            entry.gcalEventId = null;
            save();
            await pushToGCal(entry, silent);
          } else {
            const err = await res.json().catch(() => null);
            const msg = err?.error?.message || "";
            if (res.status === 400 && /invalid start time/i.test(msg)) {
              // The event on GCal's side is stuck in a state PATCH can't reconcile
              // (e.g. it was created as an all-day event and can't be converted to
              // a timed one in place) — delete the stuck event first, THEN create
              // fresh. Without the delete, the old event is orphaned on Google's
              // side and shows up as a duplicate alongside the new one.
              await deleteFromGCal(entry, true);
              entry.gcalEventId = null;
              save();
              await pushToGCal(entry, silent);
            } else if (!silent)
              toast(
                "Calendar update failed — " + (msg || `HTTP ${res.status}`),
              );
          }
        } catch {
          if (!silent) toast("Could not reach Google Calendar.");
        }
      }

      async function deleteFromGCal(entry, silent = false) {
        if (!gcalToken || !entry?.gcalEventId) return;
        try {
          const res = await fetch(
            `https://www.googleapis.com/calendar/v3/calendars/primary/events/${entry.gcalEventId}`,
            {
              method: "DELETE",
              headers: { Authorization: `Bearer ${gcalToken}` },
            },
          );
          checkGCalAuthExpired(res);
          if (!silent) {
            if (res.ok || res.status === 204)
              toast(`Calendar event removed for "${entry.name}".`);
            else {
              const err = await res.json().catch(() => null);
              toast(
                "Calendar delete failed — " +
                  (err?.error?.message || `HTTP ${res.status}`) +
                  ". Remove manually.",
              );
            }
          }
        } catch {
          if (!silent) toast("Could not reach Google Calendar.");
        }
      }

      // ── Google Tasks ────────────────────────────────────────────────────────────
      async function pushToGTask(entry, silent = false) {
        if (!gcalToken || !entry?.deadline) {
          if (!silent) toast("No due date set.");
          return;
        }
        try {
          // If we already have the task ID, PATCH instead of creating a duplicate
          if (entry.gcalTaskId) {
            await patchGTask(entry, silent);
            return;
          }
          const body = {
            title: buildGTaskTitle(entry),
            notes: entry.remark || "",
            due: entry.deadline + "T00:00:00.000Z",
            status: "needsAction",
          };
          const res = await fetch(
            "https://tasks.googleapis.com/tasks/v1/lists/@default/tasks",
            {
              method: "POST",
              headers: {
                Authorization: `Bearer ${gcalToken}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify(body),
            },
          );
          checkGCalAuthExpired(res);
          if (res.ok) {
            const created = await res.json();
            entry.gcalTaskId = created.id;
            touchEntry(entry);
            save();
            if (!silent) toast(`"${entry.name}" added to Google Tasks.`);
          } else {
            const err = await res.json();
            if (!silent)
              toast(
                "Tasks error — " +
                  (err.error?.message || "token may have expired."),
              );
          }
        } catch {
          if (!silent) toast("Could not reach Google Tasks.");
        }
      }

      async function patchGTask(entry, silent = false) {
        if (!gcalToken || !entry?.gcalTaskId) return;
        try {
          const body = {
            title: buildGTaskTitle(entry),
            notes: entry.remark || "",
            due: entry.deadline + "T00:00:00.000Z",
            // Only assert status when the app has an opinion (checkbox was used).
            // Omitting it preserves completions made inside Google Tasks — always
            // sending needsAction silently reopened them on any edit.
            ...(entry.completed !== undefined && {
              status: entry.completed ? "completed" : "needsAction",
            }),
          };
          const res = await fetch(
            `https://tasks.googleapis.com/tasks/v1/lists/@default/tasks/${entry.gcalTaskId}`,
            {
              method: "PATCH",
              headers: {
                Authorization: `Bearer ${gcalToken}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify(body),
            },
          );
          checkGCalAuthExpired(res);
          if (res.ok) {
            if (!silent) toast(`Task updated for "${entry.name}".`);
          } else {
            const err = await res.json().catch(() => null);
            if (!silent)
              toast(
                "Task update failed — " +
                  (err?.error?.message || `HTTP ${res.status}`),
              );
          }
        } catch {
          if (!silent) toast("Could not reach Google Tasks.");
        }
      }

      async function deleteFromGTask(entry, silent = false) {
        if (!gcalToken || !entry?.gcalTaskId) return;
        try {
          const res = await fetch(
            `https://tasks.googleapis.com/tasks/v1/lists/@default/tasks/${entry.gcalTaskId}`,
            {
              method: "DELETE",
              headers: { Authorization: `Bearer ${gcalToken}` },
            },
          );
          checkGCalAuthExpired(res);
          if (!silent) {
            if (res.ok || res.status === 204)
              toast(`Task removed for "${entry.name}".`);
            else {
              const err = await res.json().catch(() => null);
              toast(
                "Task delete failed — " +
                  (err?.error?.message || `HTTP ${res.status}`) +
                  ". Remove manually.",
              );
            }
          }
        } catch {
          if (!silent) toast("Could not reach Google Tasks.");
        }
      }

      // ── Cross-device Sync (Google Drive appData) ───────────────────────────────
      // One hidden JSON file in the connected Google account's appDataFolder holds
      // entries + archive + trash + tombstones + type settings. Merge rule: union by
      // id, newest effective timestamp wins per entry; tombstones (permanent
      // deletes) kill an entry everywhere unless it was edited after the delete.
      // Theme/UI settings deliberately NOT synced (per-device preference).
      const SYNC_NS = "wl2dev_"; // becomes 'wl2_' via the production promotion transform
      const SYNC_FILE_NAME =
        SYNC_NS === "wl2_" ? "worklog-sync.json" : "worklog-dev-sync.json";
      let tombstones = JSON.parse(
        localStorage.getItem("wl2dev_tombstones") || "[]",
      ); // [{id, ts}]
      let typeTombstones = JSON.parse(
        localStorage.getItem("wl2dev_type_tombstones") || "[]",
      ); // [{name, ts}] — deleted custom types, so a union merge doesn't resurrect them
      function saveTypeTombstones() {
        localStorage.setItem(
          "wl2dev_type_tombstones",
          JSON.stringify(typeTombstones),
        );
      }
      let syncFileId = localStorage.getItem("wl2dev_sync_file_id") || null;
      let syncInProgress = false;
      let syncDebounceTimer = null;
      let syncPendingAgain = false; // a save happened while a sync was in flight
      let syncDirty = false; // local data changed since the last successful upload

      function saveTombstones() {
        localStorage.setItem("wl2dev_tombstones", JSON.stringify(tombstones));
      }
      function addTombstones(ids) {
        const ts = Date.now();
        ids.forEach((id) => tombstones.push({ id, ts }));
        saveTombstones();
      }

      // Effective last-touched time of an entry, across the field-name variants the
      // app has used over its life (updated/updatedAt, created/createdAt) plus the
      // state-change stamps (deletedAt, archivedAt).
      function entryTs(e) {
        let t = 0;
        [
          "updatedAt",
          "updated",
          "deletedAt",
          "archivedAt",
          "createdAt",
          "created",
        ].forEach((k) => {
          if (e && e[k]) {
            const v = new Date(e[k]).getTime();
            if (v > t) t = v;
          }
        });
        return t;
      }

      function buildSyncPayload() {
        return {
          version: 1,
          savedAt: new Date().toISOString(),
          settingsUpdatedAt:
            localStorage.getItem("wl2dev_settings_updated") || "",
          entries,
          archived,
          trash,
          tombstones,
          typeTombstones,
          customTypes,
          typeColors,
          typeGCalIds,
          customTypeOrder,
          typeOrder,
        };
      }

      async function driveFindSyncFile() {
        const res = await fetch(
          "https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&fields=files(id,name)&pageSize=100",
          {
            headers: { Authorization: `Bearer ${gcalToken}` },
          },
        );
        checkGCalAuthExpired(res);
        if (!res.ok)
          throw new Error("Drive list failed (HTTP " + res.status + ")");
        const data = await res.json();
        const f = (data.files || []).find((f) => f.name === SYNC_FILE_NAME);
        return f ? f.id : null;
      }

      async function driveDownloadSync(fileId) {
        const res = await fetch(
          `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
          {
            headers: { Authorization: `Bearer ${gcalToken}` },
          },
        );
        checkGCalAuthExpired(res);
        if (res.status === 404) return { notFound: true };
        if (!res.ok)
          throw new Error("Drive download failed (HTTP " + res.status + ")");
        return await res.json();
      }

      async function driveUploadSync(fileId, payload) {
        let res;
        if (fileId) {
          res = await fetch(
            `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`,
            {
              method: "PATCH",
              headers: {
                Authorization: `Bearer ${gcalToken}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify(payload),
            },
          );
        } else {
          const boundary = "wl2syncboundary";
          const body =
            `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
            JSON.stringify({
              name: SYNC_FILE_NAME,
              parents: ["appDataFolder"],
            }) +
            `\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n` +
            JSON.stringify(payload) +
            `\r\n--${boundary}--`;
          res = await fetch(
            "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart",
            {
              method: "POST",
              headers: {
                Authorization: `Bearer ${gcalToken}`,
                "Content-Type": `multipart/related; boundary=${boundary}`,
              },
              body,
            },
          );
        }
        checkGCalAuthExpired(res);
        if (!res.ok) {
          const err = await res.json().catch(() => null);
          throw new Error(
            err?.error?.message ||
              "Drive upload failed (HTTP " + res.status + ")",
          );
        }
        const data = await res.json().catch(() => null);
        return data?.id || fileId;
      }

      // Merge remote payload into local state. Returns {pulled, pushed, removed}.
      function mergeSync(remote) {
        const purgeCut = Date.now() - 5 * 86400000; // same rule as local trash auto-purge
        const local = {};
        entries.forEach((e) => (local[e.id] = { e, list: "entries" }));
        archived.forEach((e) => (local[e.id] = { e, list: "archived" }));
        trash.forEach((e) => (local[e.id] = { e, list: "trash" }));
        const rem = {};
        (remote.entries || []).forEach((e) => {
          if (e && e.id) rem[e.id] = { e, list: "entries" };
        });
        (remote.archived || []).forEach((e) => {
          if (e && e.id) rem[e.id] = { e, list: "archived" };
        });
        (remote.trash || []).forEach((e) => {
          if (
            e &&
            e.id &&
            (!e.deletedAt || new Date(e.deletedAt).getTime() > purgeCut)
          )
            rem[e.id] = { e, list: "trash" };
        });

        // Tombstones: union, keeping the newest ts per id
        const tombMap = {};
        tombstones.forEach((t) => {
          tombMap[t.id] = Math.max(tombMap[t.id] || 0, t.ts);
        });
        (remote.tombstones || []).forEach((t) => {
          if (t && t.id) tombMap[t.id] = Math.max(tombMap[t.id] || 0, t.ts);
        });

        let pulled = 0,
          pushed = 0,
          removed = 0;
        const out = { entries: [], archived: [], trash: [] };
        const place = (rec) => out[rec.list].push(rec.e);

        const allIds = new Set([...Object.keys(local), ...Object.keys(rem)]);
        allIds.forEach((id) => {
          const l = local[id],
            r = rem[id];
          const lt = l ? entryTs(l.e) : 0;
          const rt = r ? entryTs(r.e) : 0;
          const winTs = Math.max(lt, rt);
          if (tombMap[id] && tombMap[id] >= winTs) {
            // permanently deleted somewhere, and not edited since
            if (l) removed++;
            return;
          }
          if (!l) {
            pulled++;
            place(r);
            return;
          }
          if (!r) {
            pushed++;
            place(l);
            return;
          }
          if (rt > lt) {
            pulled++;
            place(r);
          } else {
            if (lt > rt) pushed++;
            place(l);
          }
        });

        entries = out.entries;
        archived = out.archived;
        trash = out.trash;
        tombstones = Object.keys(tombMap)
          .filter((id) => tombMap[id] > Date.now() - 30 * 86400000) // prune old tombstones
          .map((id) => ({ id: Number(id) || id, ts: tombMap[id] }));

        // Type settings: UNION by name — a type known to either side survives,
        // instead of one side's whole list replacing the other's (that wholesale
        // swap is what let a stale/empty device wipe out real customisations).
        // Per-field conflicts (colour, GCal id, order) are settled by whichever
        // side has the newer settings stamp. Deletions travel via typeTombstones
        // so a union merge doesn't resurrect a type someone removed on purpose.
        const localTs = localStorage.getItem("wl2dev_settings_updated") || "";
        const remoteTs = remote.settingsUpdatedAt || "";
        if (Array.isArray(remote.customTypes)) {
          const remoteNewer = remoteTs > localTs;

          const typeTombMap = {};
          typeTombstones.forEach((t) => {
            if (t && t.name)
              typeTombMap[t.name] = Math.max(typeTombMap[t.name] || 0, t.ts);
          });
          (remote.typeTombstones || []).forEach((t) => {
            if (t && t.name)
              typeTombMap[t.name] = Math.max(typeTombMap[t.name] || 0, t.ts);
          });

          const nameSet = new Set([...customTypes, ...remote.customTypes]);
          nameSet.forEach((n) => {
            if (typeTombMap[n]) nameSet.delete(n);
          });
          customTypes = [...nameSet];

          const remoteColors = remote.typeColors || {};
          const remoteGCalIds = remote.typeGCalIds || {};
          const mergedColors = { ...typeColors };
          const mergedGCalIds = { ...typeGCalIds };
          [
            ...new Set([
              ...Object.keys(typeColors),
              ...Object.keys(remoteColors),
            ]),
          ].forEach((n) => {
            if (remoteColors[n] && (remoteNewer || !typeColors[n]))
              mergedColors[n] = remoteColors[n];
          });
          [
            ...new Set([
              ...Object.keys(typeGCalIds),
              ...Object.keys(remoteGCalIds),
            ]),
          ].forEach((n) => {
            if (
              remoteGCalIds[n] != null &&
              (remoteNewer || typeGCalIds[n] == null)
            )
              mergedGCalIds[n] = remoteGCalIds[n];
          });
          Object.keys(mergedColors).forEach((n) => {
            if (typeTombMap[n]) delete mergedColors[n];
          });
          Object.keys(mergedGCalIds).forEach((n) => {
            if (typeTombMap[n]) delete mergedGCalIds[n];
          });
          typeColors = mergedColors;
          typeGCalIds = mergedGCalIds;

          // Order: newer side's ordering leads, any type it doesn't mention
          // (only known to the older side) is appended at the end.
          const orderBase = remoteNewer ? remote.typeOrder || [] : typeOrder;
          const coBase = remoteNewer
            ? remote.customTypeOrder || []
            : customTypeOrder;
          const finish = (base, all) => {
            const kept = base.filter((n) => all.includes(n));
            all.forEach((n) => {
              if (!kept.includes(n)) kept.push(n);
            });
            return kept;
          };
          typeOrder = finish(orderBase, [...allTypes(), ...customTypes]).filter(
            (n, i, a) => a.indexOf(n) === i,
          );
          customTypeOrder = finish(coBase, customTypes).filter(
            (n, i, a) => a.indexOf(n) === i,
          );

          typeTombstones = Object.keys(typeTombMap)
            .filter((n) => typeTombMap[n] > Date.now() - 30 * 86400000)
            .map((n) => ({ name: n, ts: typeTombMap[n] }));
          saveTypeTombstones();

          localStorage.setItem(
            "wl2dev_custom_types",
            JSON.stringify(customTypes),
          );
          localStorage.setItem(
            "wl2dev_type_colors",
            JSON.stringify(typeColors),
          );
          localStorage.setItem(
            "wl2dev_type_gcal_ids",
            JSON.stringify(typeGCalIds),
          );
          localStorage.setItem(
            "wl2dev_custom_type_order",
            JSON.stringify(customTypeOrder),
          );
          localStorage.setItem("wl2dev_type_order", JSON.stringify(typeOrder));
          if (remoteNewer)
            localStorage.setItem("wl2dev_settings_updated", remoteTs);
          populateTypeSelects();
        }

        persistMerged();
        return { pulled, pushed, removed };
      }

      function editUiOpen() {
        return (
          editingId !== null ||
          document.getElementById("cal-edit-modal")?.classList.contains("open")
        );
      }
      async function performSync(manual = false) {
        if (syncInProgress) {
          if (manual) toast("Sync already running.");
          return false;
        }
        // Never merge under an open edit (inline card OR calendar edit modal): the
        // form is a snapshot, so Save would overwrite whatever the merge pulled in
        // and stamp it newest — silently reverting the other device's change.
        // Retry after the edit closes.
        if (editUiOpen()) {
          if (manual) {
            toast("Finish the open edit first, then sync.");
            return false;
          }
          clearTimeout(syncDebounceTimer);
          syncDebounceTimer = setTimeout(() => performSync(), 4000);
          return false;
        }
        if (!gcalToken || gcalExpired) {
          if (manual)
            toast(
              "Connect Google Calendar first — sync needs a live connection.",
            );
          return false;
        }
        syncInProgress = true;
        updateSyncStatusUI("Syncing…");
        try {
          // One-time safety snapshot of local data before the first merge ever runs
          if (!localStorage.getItem("wl2dev_pre_sync_backup")) {
            localStorage.setItem(
              "wl2dev_pre_sync_backup",
              JSON.stringify({
                at: new Date().toISOString(),
                entries,
                archived,
                trash,
              }),
            );
          }
          if (!syncFileId) syncFileId = await driveFindSyncFile();
          let remote = null;
          if (syncFileId) {
            remote = await driveDownloadSync(syncFileId);
            if (remote && remote.notFound) {
              syncFileId = null;
              remote = null;
            }
          }
          const stats = remote
            ? mergeSync(remote)
            : {
                pulled: 0,
                pushed: entries.length + archived.length,
                removed: 0,
              };
          // Upload only when something local needs to reach the remote: a real user
          // change since the last upload, merge-detected local-newer entries, or no
          // remote file yet. Pure pulls and no-op syncs skip the write entirely.
          if (syncDirty || stats.pushed > 0 || !syncFileId) {
            // Clear the flag BEFORE the upload starts, so a save that lands while
            // the upload is in flight re-arms it and is picked up by the follow-up
            // pass. Clearing after the await used to swallow those saves.
            const wasDirty = syncDirty;
            syncDirty = false;
            const payload = buildSyncPayload();
            let newId;
            try {
              newId = await driveUploadSync(syncFileId, payload);
            } catch (err) {
              if (wasDirty) syncDirty = true;
              throw err;
            }
            if (newId && newId !== syncFileId) {
              syncFileId = newId;
              localStorage.setItem("wl2dev_sync_file_id", newId);
            }
          }
          localStorage.setItem("wl2dev_last_sync", new Date().toISOString());
          if (stats.pulled || stats.removed) {
            // Never re-render over an open inline edit — it would rebuild the card
            // from stored state and wipe the user's typing. The save/cancel that
            // closes the edit re-renders anyway.
            if (editingId === null) render();
            updateTrashBadge();
            if (
              document
                .getElementById("trash-overlay")
                ?.classList.contains("open")
            )
              renderTrash();
          }
          updateSyncStatusUI();
          if (manual || stats.pulled || stats.removed) {
            toast(
              `Synced — ${stats.pulled} pulled, ${stats.pushed} pushed${stats.removed ? ", " + stats.removed + " removed" : ""}.`,
              3000,
            );
          }
          return true;
        } catch (err) {
          updateSyncStatusUI("Sync failed");
          if (manual)
            toast("Sync failed — " + (err?.message || "network error"), 3500);
          return false;
        } finally {
          syncInProgress = false;
          // A save landed while this sync was running — its data wasn't in the
          // upload, so schedule one more pass instead of dropping it.
          if (syncPendingAgain) {
            syncPendingAgain = false;
            scheduleSync();
          }
        }
      }

      // Debounced auto-sync after local changes (called from save()).
      function scheduleSync() {
        if (!gcalToken || gcalExpired) return;
        if (syncInProgress) {
          syncPendingAgain = true;
          return;
        }
        clearTimeout(syncDebounceTimer);
        syncDebounceTimer = setTimeout(() => performSync(), 4000);
      }

      function updateSyncStatusUI(override) {
        const el = document.getElementById("sync-status-text");
        if (!el) return;
        if (override) {
          el.textContent = override;
          return;
        }
        const last = localStorage.getItem("wl2dev_last_sync");
        el.textContent = last
          ? "Last synced " + new Date(last).toLocaleString()
          : "Not synced yet";
      }

      // ── Settings ───────────────────────────────────────────────────────────────
      // Google's official names for colour IDs 1-11 (the API only returns hex, not
      // names). Any id beyond 11 that Google adds gets a plain "Color N" label —
      // GCAL_COLOR_MAP/OPTIONS/NAMES are rebuilt from the live `colors` endpoint
      // (see fetchGCalColors below) instead of hardcoded, so a Google-side palette
      // expansion shows up automatically instead of silently missing new colours.
      const GCAL_COLOR_STATIC_NAMES = {
        1: "Lavender",
        2: "Sage",
        3: "Grape",
        4: "Flamingo",
        5: "Banana",
        6: "Tangerine",
        7: "Peacock",
        8: "Graphite",
        9: "Blueberry",
        10: "Basil",
        11: "Tomato",
      };
      const GCAL_COLOR_STATIC_HEX = {
        1: "#7986cb",
        2: "#33b679",
        3: "#8e24aa",
        4: "#e67c73",
        5: "#f6c026",
        6: "#f5511d",
        7: "#039be5",
        8: "#616161",
        9: "#3f51b5",
        10: "#0b8043",
        11: "#d60000",
      };
      let GCAL_COLOR_OPTIONS, GCAL_COLOR_MAP, GCAL_COLOR_NAMES;
      function rebuildGCalColorTables(eventColors) {
        const ids = Object.keys(eventColors).sort((a, b) => +a - +b);
        const map = { "": "transparent" },
          names = {},
          options = [{ id: "", label: "— None —" }];
        ids.forEach((id) => {
          map[id] = eventColors[id].background || eventColors[id];
          const name = GCAL_COLOR_STATIC_NAMES[id] || "Color " + id;
          names[id] = name;
          options.push({ id, label: `${id} · ${name}` });
        });
        GCAL_COLOR_MAP = map;
        GCAL_COLOR_NAMES = names;
        GCAL_COLOR_OPTIONS = options;
      }
      rebuildGCalColorTables(GCAL_COLOR_STATIC_HEX);

      let gcalColorsFetched = false;
      // Live palette differs from the hardcoded 1-11 fallback the moment Google
      // adds colours on their end — fetch once per session while connected so the
      // Settings picker always reflects what's actually selectable via the API.
      async function fetchGCalColors() {
        if (!gcalToken || gcalColorsFetched) return;
        try {
          const res = await fetch(
            "https://www.googleapis.com/calendar/v3/colors",
            {
              headers: { Authorization: `Bearer ${gcalToken}` },
            },
          );
          if (!res.ok || !res.headers.get("content-type")?.includes("json"))
            return;
          const data = await res.json();
          if (!data.event || !Object.keys(data.event).length) return;
          rebuildGCalColorTables(data.event);
          gcalColorsFetched = true;
          if (
            document
              .getElementById("settings-overlay")
              ?.classList.contains("open")
          )
            buildSettingsUI();
        } catch {
          /* offline or blocked — static fallback already in place */
        }
      }

      let settingsSnapshot = null;
      let settingsDirty = false;
      let pendingTheme = null; // previewed-but-uncommitted theme while Settings is open
      let pendingCustomEdited = false; // user tweaked individual colours (a custom look)
      function activeThemeName() {
        return pendingTheme !== null
          ? pendingTheme
          : localStorage.getItem("wl2dev_current_theme") || "default";
      }

      function openSettings() {
        settingsSnapshot = {
          customTypes: [...customTypes],
          typeOrder: [...typeOrder],
          customTypeOrder: [...customTypeOrder],
          typeColors: { ...typeColors },
          typeGCalIds: { ...typeGCalIds },
          builtinTypes: [...BUILTIN_TYPES],
          savedThemes: JSON.stringify(savedThemes),
        };
        settingsDirty = false;
        pendingTheme =
          localStorage.getItem("wl2dev_current_theme") || "default";
        pendingCustomEdited = false;
        buildSettingsUI();
        document.getElementById("settings-overlay").classList.add("open");
        document.body.classList.add("no-scroll");
      }
      function closeSettingsForce() {
        document.getElementById("settings-overlay").classList.remove("open");
        document.body.classList.remove("no-scroll");
      }
      function closeSettings() {
        if (settingsDirty) {
          document
            .getElementById("settings-unsaved-modal")
            .classList.add("open");
          return;
        }
        closeSettingsForce();
      }
      function cancelUnsavedPrompt() {
        document
          .getElementById("settings-unsaved-modal")
          .classList.remove("open");
      }
      function discardSettingsChanges() {
        customTypes = [...settingsSnapshot.customTypes];
        typeOrder = [...settingsSnapshot.typeOrder];
        customTypeOrder = [...settingsSnapshot.customTypeOrder];
        typeColors = { ...settingsSnapshot.typeColors };
        typeGCalIds = { ...settingsSnapshot.typeGCalIds };
        BUILTIN_TYPES.length = 0;
        BUILTIN_TYPES.push(...settingsSnapshot.builtinTypes);
        savedThemes = JSON.parse(settingsSnapshot.savedThemes);
        localStorage.setItem(
          "wl2dev_saved_themes",
          JSON.stringify(savedThemes),
        );
        pendingTheme = null;
        pendingCustomEdited = false;
        loadTheme();
        populateTypeSelects();
        render();
        settingsDirty = false;
        document
          .getElementById("settings-unsaved-modal")
          .classList.remove("open");
        closeSettingsForce();
        toast("Changes discarded.");
      }
      function saveAndCloseSettings() {
        document
          .getElementById("settings-unsaved-modal")
          .classList.remove("open");
        saveSettings();
      }

      function updateGCalColorPreview(type) {
        const select = document.getElementById("tc-gcal-" + type);
        const swatch = document.getElementById("tc-swatch-" + type);
        const nameLabel = document.getElementById("tc-name-" + type);
        const gcalId = select.value;
        const color = GCAL_COLOR_MAP[gcalId] || "transparent";
        swatch.style.background = color;
        swatch.style.opacity = gcalId ? "1" : "0.3";
        if (nameLabel) nameLabel.textContent = GCAL_COLOR_NAMES[gcalId] || "";
        typeGCalIds[type] = gcalId;
        settingsDirty = true;
      }

      function buildSettingsUI() {
        // Types list
        const typesList = document.getElementById("settings-types-list");
        typesList.innerHTML = allTypes()
          .map((t) => {
            const isBuiltin = BUILTIN_TYPES.includes(t);
            const color = typeColors[t] || "#888888";
            const gcalId = typeGCalIds[t] || "";
            const gcalOpts = GCAL_COLOR_OPTIONS.map(
              (o) =>
                `<option value="${o.id}"${gcalId === o.id ? " selected" : ""}>${esc(o.label)}</option>`,
            ).join("");
            const gcalColor = GCAL_COLOR_MAP[gcalId] || "transparent";
            const dragHandle = `<div style="cursor:grab;padding:4px;margin-right:4px;color:var(--text3);">☰</div>`;
            return `<div class="type-row" id="type-row-${esc(t)}" draggable="true">
      ${dragHandle}
      <div class="color-input-wrap" style="gap:4px;">
        <input type="color" id="tc-color-${esc(t)}" value="${color}" oninput="document.getElementById('tc-hex-${esc(t)}').value=this.value;" onchange="syncTypeColorHex('${esc(t)}')">
        <input type="text" id="tc-hex-${esc(t)}" value="${color}" style="width:78px;font-size:11px;" oninput="settingsDirty=true;(function(v,id){if(/^#[0-9a-fA-F]{6}$/.test(v))document.getElementById('tc-color-'+id).value=v;})( this.value,'${esc(t)}'  )">
      </div>
      <span class="type-label">${esc(t)}${isBuiltin ? "" : ' <span style="font-size:10px;color:var(--text3);">(custom)</span>'}</span>
      <select class="type-gcal-select" id="tc-gcal-${esc(t)}" onchange="updateGCalColorPreview('${esc(t)}')">${gcalOpts}</select>
      <div style="display:flex;align-items:center;gap:6px;flex-shrink:0;">
        <div class="gcal-color-swatch" id="tc-swatch-${esc(t)}" style="width:18px;height:18px;border-radius:4px;border:1px solid var(--border);background:${gcalColor};${gcalId ? "" : "opacity:.3;"}"></div>
        <span id="tc-name-${esc(t)}" style="font-size:11px;color:var(--text2);min-width:60px;">${GCAL_COLOR_NAMES[gcalId] || ""}</span>
      </div>
      <button class="icon-btn del" onclick="removeType('${esc(t)}')" title="Remove type" style="width:26px;">${trashIcon()}</button>
    </div>`;
          })
          .join("");

        // Add drag event handlers for all types
        document.querySelectorAll(".type-row").forEach((el) => {
          el.addEventListener("dragstart", handleTypeRowDragStart);
          el.addEventListener("dragover", handleTypeRowDragOver);
          el.addEventListener("drop", handleTypeRowDrop);
          el.addEventListener("dragend", handleTypeRowDragEnd);
        });

        // Theme UI: build the custom pickers, fill them with the active theme's colours,
        // highlight the active preset, and render the saved-theme list.
        buildCustomEditor();
        populateCustomFromCurrent();
        markActiveTheme();
        renderSavedThemes();
      }

      let draggedTypeRow = null;

      function handleTypeRowDragStart(e) {
        draggedTypeRow = this;
        this.style.opacity = "0.5";
        e.dataTransfer.effectAllowed = "move";
      }

      function handleTypeRowDragOver(e) {
        if (e.preventDefault) e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        if (this !== draggedTypeRow)
          this.style.borderTop = "2px solid var(--accent)";
        return false;
      }

      function handleTypeRowDrop(e) {
        if (e.stopPropagation) e.stopPropagation();
        if (draggedTypeRow && draggedTypeRow !== this) {
          const fromType = draggedTypeRow.id.replace("type-row-", "");
          const toType = this.id.replace("type-row-", "");
          reorderCustomTypes(fromType, toType);
        }
        return false;
      }

      function handleTypeRowDragEnd(e) {
        this.style.opacity = "1";
        document
          .querySelectorAll(".type-row")
          .forEach((el) => (el.style.borderTop = ""));
      }

      function reorderCustomTypes(fromType, toType) {
        // Initialize typeOrder with current order if empty
        if (typeOrder.length === 0) {
          typeOrder = allTypes();
        }
        if (!typeOrder.includes(fromType)) typeOrder.push(fromType);
        if (!typeOrder.includes(toType)) typeOrder.push(toType);
        const fromIdx = typeOrder.indexOf(fromType);
        const toIdx = typeOrder.indexOf(toType);
        typeOrder.splice(fromIdx, 1);
        typeOrder.splice(toIdx > fromIdx ? toIdx - 1 : toIdx, 0, fromType);
        settingsDirty = true;
        buildSettingsUI();
      }

      function syncTypeColorHex(type) {
        settingsDirty = true;
        const colorEl = document.getElementById("tc-color-" + type);
        const hexEl = document.getElementById("tc-hex-" + type);
        if (colorEl && hexEl) hexEl.value = colorEl.value;
      }

      function addCustomType() {
        const input = document.getElementById("new-type-input");
        const name = input.value.trim();
        if (!name) {
          toast("Enter a type name.");
          return;
        }
        if (
          allTypes()
            .map((t) => t.toLowerCase())
            .includes(name.toLowerCase())
        ) {
          toast("Type already exists.");
          return;
        }
        customTypes.push(name);
        settingsDirty = true;
        input.value = "";
        buildSettingsUI();
        toast(`Type "${name}" added.`);
      }

      function removeType(name) {
        if (
          !confirm(
            `Remove type "${name}"? Entries with this type will keep their value.`,
          )
        )
          return;
        const isBuiltin = BUILTIN_TYPES.includes(name);
        if (isBuiltin) {
          // Remove from BUILTIN_TYPES by filtering it out
          const idx = BUILTIN_TYPES.indexOf(name);
          if (idx > -1) BUILTIN_TYPES.splice(idx, 1);
        } else {
          // Remove custom type. Tombstone it so a union merge with another
          // device's still-stale copy of this type doesn't bring it back.
          customTypes = customTypes.filter((t) => t !== name);
          typeTombstones.push({ name, ts: Date.now() });
          saveTypeTombstones();
        }
        // Always remove from order arrays
        customTypeOrder = customTypeOrder.filter((t) => t !== name);
        typeOrder = typeOrder.filter((t) => t !== name);
        // Remove color and gcal settings
        delete typeColors[name];
        delete typeGCalIds[name];
        settingsDirty = true;
        buildSettingsUI();
        toast(`Type "${name}" removed.`);
      }

      function removeCustomType(name) {
        // Backward compatibility - calls the new removeType function
        removeType(name);
      }

      function saveSettings() {
        // Collect type colors and gcal IDs
        allTypes().forEach((t) => {
          const hexEl = document.getElementById("tc-hex-" + t);
          const gcalEl = document.getElementById("tc-gcal-" + t);
          if (hexEl) {
            const val = hexEl.value.trim();
            if (/^#[0-9a-fA-F]{6}$/.test(val)) typeColors[t] = val;
          }
          if (gcalEl) typeGCalIds[t] = gcalEl.value;
        });
        localStorage.setItem("wl2dev_type_colors", JSON.stringify(typeColors));
        localStorage.setItem(
          "wl2dev_type_gcal_ids",
          JSON.stringify(typeGCalIds),
        );
        localStorage.setItem(
          "wl2dev_custom_types",
          JSON.stringify(customTypes),
        );
        localStorage.setItem(
          "wl2dev_custom_type_order",
          JSON.stringify(customTypeOrder),
        );
        localStorage.setItem("wl2dev_type_order", JSON.stringify(typeOrder));
        // Only stamp settings_updated when the SYNCED part (types, order, colours,
        // GCal ids) actually changed. Themes stay per-device, so a theme-only save
        // must not advance the stamp — otherwise this device's possibly-stale type
        // list wins "newest" on the next merge and deletes types added elsewhere.
        // And mark data dirty, or a type-only change never uploads at all (the
        // upload guard needs syncDirty || pushed || no file).
        const typeFingerprint = () =>
          JSON.stringify({
            customTypes,
            typeOrder,
            customTypeOrder,
            typeColors,
            typeGCalIds,
          });
        const before = settingsSnapshot
          ? JSON.stringify({
              customTypes: settingsSnapshot.customTypes,
              typeOrder: settingsSnapshot.typeOrder,
              customTypeOrder: settingsSnapshot.customTypeOrder,
              typeColors: settingsSnapshot.typeColors,
              typeGCalIds: settingsSnapshot.typeGCalIds,
            })
          : null;
        if (before === null || before !== typeFingerprint()) {
          localStorage.setItem(
            "wl2dev_settings_updated",
            new Date().toISOString(),
          );
          syncDirty = true;
          scheduleSync();
        }

        // Commit the previewed theme (deferred until Save)
        if (pendingCustomEdited) {
          localStorage.setItem("wl2dev_current_theme", "custom");
          localStorage.setItem(
            "wl2dev_custom_tokens",
            JSON.stringify(readCurrentTokens()),
          );
        } else if (pendingTheme !== null && pendingTheme !== "custom") {
          localStorage.setItem("wl2dev_current_theme", pendingTheme);
          localStorage.removeItem("wl2dev_custom_tokens");
        }
        pendingTheme = null;
        pendingCustomEdited = false;

        settingsDirty = false;
        document
          .getElementById("settings-unsaved-modal")
          .classList.remove("open");
        closeSettingsForce();
        populateTypeSelects();
        render();
        toast("Settings saved.");
      }

      // ── Changelog ──────────────────────────────────────────────────────────────
      const CHANGELOG = [
        {
          version: "v1.9.3",
          date: "August 27, 2026",
          latest: true,
          items: [
            "Under the hood: the app source is now split into three files (HTML, CSS, JavaScript) and assembled into this single page by a build step — no visible change",
          ],
        },
        {
          version: "v1.9.2",
          date: "August 27, 2026",
          latest: false,
          items: [
            "Fixed: switching an entry from all-day to a specific time could leave a duplicate leftover event on Google Calendar instead of updating it in place",
          ],
        },
        {
          version: "v1.9.1",
          date: "August 27, 2026",
          latest: false,
          items: [
            "Fixed: the calendar edit modal closed if you clicked outside it, easy to trigger by accident mid-edit — it now only closes via Cancel, Save, or Escape",
          ],
        },
        {
          version: "v1.9.0",
          date: "August 27, 2026",
          latest: false,
          items: [
            "List view: hold down an entry to select it (mobile) alongside the existing Select button (desktop); selected entries can now be moved to a new date, in addition to archive/delete",
          ],
        },
        {
          version: "v1.8.24",
          date: "August 25, 2026",
          latest: false,
          items: [
            'Fixed: a day could show "+N more" with none of its own entries visible, even with just 2-3 entries — caused by a multi-day event elsewhere in the same week eating into every day\'s space; unrelated days now keep their full room',
          ],
        },
        {
          version: "v1.8.23",
          date: "August 25, 2026",
          latest: false,
          items: [
            "Fixed: on mobile, multi-day calendar entries (e.g. an event spanning two days) could appear shifted under the wrong date column until you scrolled the calendar sideways — the entry bar now scrolls in lockstep with the day columns",
          ],
        },
        {
          version: "v1.8.22",
          date: "August 21, 2026",
          latest: false,
          items: [
            "Fixed: restoring a completed task from the archive left it stuck marked done, and unchecking it afterward created a duplicate — restoring a task now clears its done state properly",
          ],
        },
        {
          version: "v1.8.21",
          date: "August 21, 2026",
          latest: false,
          items: [
            "Calendar: checking a task's checkbox now automatically archives it; unchecking a task in the archive restores it to active",
          ],
        },
        {
          version: "v1.8.20",
          date: "August 21, 2026",
          latest: false,
          items: [
            "Fixed: syncing across devices could wipe out custom task types and colours — cross-device type sync now merges both devices' types together instead of one side's list replacing the other's",
          ],
        },
        {
          version: "v1.8.19",
          date: "August 18, 2026",
          latest: false,
          items: [
            "Date fields: keyboard Tab skips the invisible native input and reaches the calendar button; screen readers hear the field name with each block (e.g. Deadline, Day)",
            "Phone: bigger calendar-button tap target in date fields",
          ],
        },
        {
          version: "v1.8.18",
          date: "August 18, 2026",
          latest: false,
          items: [
            "Toasts no longer block taps — the + button and anything under a toast now work immediately (Undo link still tappable)",
            "Phone: toasts show at the top of the screen, clear of the + button",
          ],
        },
        {
          version: "v1.8.17",
          date: "August 18, 2026",
          latest: false,
          items: [
            "Date fields: day, month and year are now locked blocks like the native picker — click a block to select it, type to overwrite, Backspace clears the whole block (empty block hops back), and cleared blocks show a grey dd / mm / yyyy placeholder without shifting the rest",
          ],
        },
        {
          version: "v1.8.16",
          date: "August 18, 2026",
          latest: false,
          items: [
            "Date fields: clicking the year (or month) now selects that part — it no longer snaps back to the day",
          ],
        },
        {
          version: "v1.8.15",
          date: "August 18, 2026",
          latest: false,
          items: [
            "Date fields: click day, month or year to select that part and retype it — typing overwrites and hops to the next part when full, like the old control; backspace still flows through",
          ],
        },
        {
          version: "v1.8.14",
          date: "August 18, 2026",
          latest: false,
          items: [
            "Date fields: type dd/mm/yyyy straight through — slashes auto-inserted, backspace flows across day/month/year instead of sticking in one segment; calendar button opens the picker",
            "Applies everywhere: entry form, task due date, repeat end, quick-add, edit forms and the due-alert extend field",
          ],
        },
        {
          version: "v1.8.13",
          date: "August 18, 2026",
          latest: false,
          items: [
            "Polish: breathing room between the Repeat box and the Add entry button in the sidebar form",
          ],
        },
        {
          version: "v1.8.12",
          date: "August 18, 2026",
          latest: false,
          items: [
            "Keyboard: multi-day event bars, task tick in chips, year-view month names and the undated-entries link are now tabbable and open with Enter/Space",
          ],
        },
        {
          version: "v1.8.11",
          date: "August 18, 2026",
          latest: false,
          items: [
            "Keyboard: calendar day cells, chips, +N more, year-view days and day-list rows can be tabbed to and opened with Enter/Space",
            "Contrast: muted text lifted in Ocean, Cyan, Light and Rose themes to meet WCAG AA",
            "Phone: bigger tap targets for year-view days, time-picker rows and day-list rows",
            "Reduced-motion: only large movement is disabled now — hover/focus/selection feedback stays",
            "Performance: icon-button accessibility pass and Repeat popover repositioning are batched per frame",
          ],
        },
        {
          version: "v1.8.10",
          date: "August 18, 2026",
          latest: false,
          items: [
            "Time fields: backspace now deletes through the auto-inserted colon smoothly instead of sticking on it; a colon you type yourself is kept",
          ],
        },
        {
          version: "v1.8.9",
          date: "August 18, 2026",
          latest: false,
          items: [
            "Phone: New Entry close button now sits on its own row above the form, larger and bordered — no more accidental close when tapping Task",
            "Phone: time fields open the numeric keyboard directly instead of the scroll-wheel dropdown",
            "Calendar year view: Today now scrolls the current month into view instead of jumping to January",
          ],
        },
        {
          version: "v1.8.8",
          date: "August 18, 2026",
          latest: false,
          items: [
            "Repeat popover now shows a caret pointing at the Repeat checkbox and the checkbox box glows while it is open — clear which control it belongs to",
            "Settings on phones: each Task Type now wraps onto two lines so the delete button is never cut off",
            "Accessibility: toasts are announced by screen readers; time picker and saved-theme name fields get the same visible focus ring as other inputs",
          ],
        },
        {
          version: "v1.8.7",
          date: "August 18, 2026",
          latest: false,
          items: [
            "Fix: repeat popover was clipped by the sidebar and could not scroll — now rendered above the page, scrolls inside itself, always fits the window",
          ],
        },
        {
          version: "v1.8.6",
          date: "August 18, 2026",
          latest: false,
          items: [
            "Repeat builder now opens in a popover beside the sidebar — the form stays compact and a one-line summary (rule · until date · count) with Edit shows what you picked",
            "Validation errors now appear on the field itself (red ring + message) for name and end-before-start, in add, edit and calendar quick-add",
            "Calendar: hover any month chip to see the full entry name",
            "Accessibility: honours the OS reduce-motion setting — animations and transitions switch off",
          ],
        },
        {
          version: "v1.8.5",
          date: "August 18, 2026",
          latest: false,
          items: [
            "Fix: the due-TODAY deadline chip no longer scatters into ragged text on phones — wraps as one clean sentence",
            "Calendar: overdue entries with a type colour now carry a red ! badge so they stand out regardless of the colour",
            "Sidebar: Export / Export Archive / Import folded into one collapsed Export & Import section so New Entry is the focus",
            "Guard: end date can no longer be set before the start date (add + edit) — the end field snaps to the start and a toast explains",
          ],
        },
        {
          version: "v1.8.4",
          date: "August 18, 2026",
          latest: false,
          items: [
            "Delete/Trash toast now has an Undo button — restores the entry (or entries) right back instead of digging through Settings → Trash",
            "Archived-list permanent delete icon now visually distinct from the active-list soft-delete (Move to Trash) icon",
          ],
        },
        {
          version: "v1.8.3",
          date: "August 18, 2026",
          latest: false,
          items: [
            "Polish (from the technical audit): swapped the bouncy easter-egg modal pop-in for a smoother deceleration curve",
          ],
        },
        {
          version: "v1.8.2",
          date: "August 17, 2026",
          latest: false,
          items: [
            "Accessibility (from the technical audit): Dusty Pink and Woodland theme accent colours darkened slightly to meet WCAG AA contrast on their buttons — same hue, no visible change to the palette identity",
          ],
        },
        {
          version: "v1.8.1",
          date: "August 17, 2026",
          latest: false,
          items: [
            "Code review round 3 (10 fixes). Sync: saving an Event/Task switch can no longer save blank fields or create two Google copies (double-click / cancel mid-save); a freshly pushed Google id now wins on other devices instead of spawning a duplicate calendar event; adding a custom type alone now syncs, and a theme-only save can no longer overwrite newer types from another device; background sync waits while an edit (card or calendar popup) is open instead of pulling under it; Clear Trash during a sync now reaches other devices",
            "Small: type names with an apostrophe work in the filter chips; the auto reconnect box no longer interrupts a reconnect already in progress or stacks over another dialog; adding an entry with a filter on (or from the Archive) no longer pops an empty day box; if Drive fails at connect it retries once and explains, instead of a silent skip; the last calendar chip is no longer clipped on tall windows",
          ],
        },
        {
          version: "v1.8.0",
          date: "August 17, 2026",
          latest: false,
          items: [
            "New: deleting an entry (single, from the calendar popup, or bulk-select) now asks first — a small confirmation that names the entry, says it is kept 5 days, and tells you where Trash is (Settings → Trash)",
            'The card delete button tooltip said "Delete permanently" — it never was; now reads "Move to Trash"',
          ],
        },
        {
          version: "v1.7.9",
          date: "August 17, 2026",
          latest: false,
          items: [
            "Sync-all button moved to sit right beside the search box (PC) / flush right of its row (phone), so the space kept for the list-only controls blends into the normal gap in Calendar view instead of reading as a hole",
          ],
        },
        {
          version: "v1.7.8",
          date: "August 17, 2026",
          latest: false,
          items: [
            "Fix: Select / sort / direction now hide and show together in one go when switching views — they were fading out one after another because their hover animation was also animating the hide",
          ],
        },
        {
          version: "v1.7.7",
          date: "August 17, 2026",
          latest: false,
          items: [
            "Switching Calendar <-> List now moves nothing at all, PC and phone: the list-only controls (Select / sort / direction) keep their space instead of disappearing, every toolbar control has the same fixed height, and the sync button no longer drops down a few pixels in List view. Verified by measuring every header/toolbar/list element in both views, connected and disconnected, on both screen sizes",
          ],
        },
        {
          version: "v1.7.6",
          date: "August 17, 2026",
          latest: false,
          items: [
            "Phone: search box keeps the same spot in both views — full-width row right under the chips; Select / sort / direction sit on their own row beneath it and simply vanish in Calendar view",
          ],
        },
        {
          version: "v1.7.5",
          date: "August 17, 2026",
          latest: false,
          items: [
            "PC: the New Entry sidebar and the entries list each scroll on their own in List view (as Calendar already did) — the page itself never scrolls, so nothing shifts when switching views",
            "PC: the search box is pinned to the far right of its row; the sort controls now sit to its left, so it stays put when they appear or disappear",
          ],
        },
        {
          version: "v1.7.4",
          date: "August 17, 2026",
          latest: false,
          items: [
            'Fix: the Event/Task switch warned "Google Calendar not connected" no matter how many times you reconnected — the liveness check was calling an endpoint our permission scope is not allowed to read (Google answered 403), so a live connection looked dead. Now checks via the events endpoint we do have access to. Affected PC and phone alike',
            "Fix: switching Calendar <-> List no longer shifts the header — the Select button moved down beside the sort controls (all list-only tools together), and the page now reserves its scrollbar width so nothing jumps 15px sideways on PC",
          ],
        },
        {
          version: "v1.7.3",
          date: "August 17, 2026",
          latest: false,
          items: [
            "Phone (from real-device screenshots): filter chips no longer get squeezed under the search box — chips take their own row, search + sort share the next; header buttons flow left in one tidy wrap instead of splitting into ragged rows; stat strip loses its desktop indent; select-mode bar puts the count on its own line; list, calendar and header all share the same 12px side gutters",
          ],
        },
        {
          version: "v1.7.2",
          date: "August 17, 2026",
          latest: false,
          items: [
            "Phone (touch pass, found by driving the app with emulated finger taps and swipes): the Edit / Quick-add forms no longer overflow — Type gets its own line and the two dates pair up beneath it, instead of Type squashed to a bare arrow and End date running off the right edge",
            "Phone: the floating + button no longer covers the Save/Cancel of the last card while editing — the list scrolls clear of it",
            "Phone: small buttons (due-today alert Archive / Extend) grow to a comfortable tap height",
          ],
        },
        {
          version: "v1.7.1",
          date: "August 17, 2026",
          latest: false,
          items: [
            "Accessibility: faint grey helper text (section labels, counts, weekday headers, empty states) darkened in every theme to meet the WCAG AA 4.5:1 contrast floor; Dusty Pink secondary text too",
            "Phone width: the topbar title no longer wraps into three lines — right-hand buttons collapse to icons and the calendar pill to its status dot instead; icon buttons grow to a 40px tap area",
            "Keyboard: Esc now closes whatever is on top (any modal, Settings, Trash, the mobile form), one layer per press; Tab stays inside an open modal instead of wandering into the page behind it; every dialog announces itself to screen readers",
            "Honours the system reduced-motion setting: panels and modals still open and close, just without the slide/fade",
          ],
        },
        {
          version: "v1.7.0",
          date: "August 17, 2026",
          latest: false,
          items: [
            "Google Calendar session expiry now pops up the reconnect modal directly (instead of a toast you could miss)",
            "Type colour picker's Google Calendar colour list is now fetched live from Google instead of a hardcoded set of 11, so it stays current if Google adds more",
            "If the Google sign-in popup is blocked, a direct link now appears in the Connect dialog with an explanation, instead of a form with no context",
          ],
        },
        {
          version: "v1.6.31",
          date: "August 13, 2026",
          latest: false,
          items: [
            "New (narrow screens only): the New Entry form now hides behind a floating + button instead of taking up the top of the page — tap + to open it full-screen, add your entry and it closes back to the list or calendar automatically. Desktop layout is completely unchanged. First step toward proper mobile support",
          ],
        },
        {
          version: "v1.6.30",
          date: "August 13, 2026",
          latest: false,
          items: [
            "Fix: the sidebar form (Work name, Type, Deadline, etc.) no longer disappears in Calendar view on a narrow screen — it was getting squeezed into a sliver by the calendar's full-height layout. Now it shows in full and scrolls with the page, same as List view, while the calendar keeps its own full-height space below it",
          ],
        },
        {
          version: "v1.6.29",
          date: "August 13, 2026",
          latest: false,
          items: [
            "From the technical audit: text fields show a clear accent-coloured ring when focused (was a barely-visible 6% shadow); icon-only buttons and calendar icons are now readable by screen readers; calendar date circles are bigger and easier to tap; search no longer causes a brief lag while typing; the calendar can scroll sideways on very narrow screens instead of squeezing unreadable",
          ],
        },
        {
          version: "v1.6.28",
          date: "August 13, 2026",
          latest: false,
          items: [
            "Fix: the List | Calendar toggle no longer disappears when the window isn't full-screen — the header now wraps to a second line instead of clipping it off-screen",
            "Fix: adding an entry while the calendar is showing now opens that day's list automatically, so the new entry is never hard to find (previously only an inner area scrolled, easy to miss on a narrow or short window)",
          ],
        },
        {
          version: "v1.6.27",
          date: "August 13, 2026",
          latest: false,
          items: [
            'Sync hardening (code review round 2): killed a loop that made the app re-sync to Drive every 4 seconds forever; no-op syncs no longer upload anything; editing a task from Work Log no longer reopens tasks you completed inside Google Tasks; "Extend to date" and bulk-archive now propagate to other devices; reconnecting mid-sync can no longer create duplicate calendar events',
            'Calendar fixes: the edit popup keeps your changes open when the name is empty instead of discarding them; quick-add no longer touches (or wipes) anything typed in the side form; the "today" circle now uses local time (it marked yesterday until 7 AM); resizing the window re-fits the grid; type names with apostrophes no longer break their filter chips; the Connect dialog opens above the edit popup',
            'Under the hood: one shared timestamp helper for every entry change, and a stricter connection check (server errors no longer count as "connected")',
          ],
        },
        {
          version: "v1.6.26",
          date: "August 13, 2026",
          latest: false,
          items: [
            "Archived entries now stay visible on the month calendar as faded strikethrough entries instead of disappearing — clicking one shows its details with a Restore to active button. Day lists include them at the bottom; the Year view stays active-only on purpose (its colour dots are a planning overview)",
          ],
        },
        {
          version: "v1.6.25",
          date: "August 13, 2026",
          latest: false,
          items: [
            'Fix: day cells no longer clip entries — the calendar now computes how many fit each cell from your actual screen height and collapses the rest into an honest "+N more" (more chips on big monitors, fewer on small, never half-drawn)',
            "Timed entries now look different from all-day ones, GCal-style: a colour dot + time + name on a plain background, while all-day events stay solid colour bands. Tasks keep their colour-tinted working checkbox",
            "Clicking a day's number opens that day's full entry list; the year dropdown now spans ±10 years around the viewed year and always includes any year that has entries",
          ],
        },
        {
          version: "v1.6.24",
          date: "August 13, 2026",
          latest: false,
          items: [
            "The app now always opens on the Calendar — switching to List lasts only until the next open or refresh, instead of being remembered",
          ],
        },
        {
          version: "v1.6.23",
          date: "August 13, 2026",
          latest: false,
          items: [
            "The view toggle now reads Calendar | List — Calendar first, matching the new startup default",
          ],
        },
        {
          version: "v1.6.22",
          date: "August 13, 2026",
          latest: false,
          items: [
            "Calendar v2 — calendar is now the startup view, the grid stretches to fill your screen on any monitor, and the month & year in the header are dropdowns for jumping anywhere directly",
            "New: Year view — a Month | Year switch shows all 12 months at once; days with entries get a solid circle in the colour of their highest-ranked task type (your Settings type order decides which wins)",
            "Entries with times now show as full colour bands like all-day ones; the task checkbox actually works — click it to mark done (strikethrough + synced to Google Tasks) and click again to undo",
            "Clicking an empty day opens a quick-add popup for that date instead of just prefilling the side form; clicking an entry's Edit now edits right there in a popup instead of jumping back to the list",
            "Entry popup shows the first two lines of a long remark with Show more, and the header stat numbers are a bit bigger",
          ],
        },
        {
          version: "v1.6.21",
          date: "August 11, 2026",
          latest: false,
          items: [
            "Fix: filter chips, the Sync All icon, and the List | Calendar toggle no longer render transparent against the page background — they sit on a solid surface again",
          ],
        },
        {
          version: "v1.6.20",
          date: "August 11, 2026",
          latest: false,
          items: [
            "Redesign: the header area is half its old height — the five stat cards are now a slim inline strip next to the title, search / sort / Sync All join the filter chips on one compact row, and the Sync All button became a quiet icon",
            'Fix: the sort dropdown no longer stretches across the whole row (it inherited the form fields\' full-width rule), and the List | Calendar toggle no longer truncates to "Cale"',
          ],
        },
        {
          version: "v1.6.19",
          date: "August 11, 2026",
          latest: false,
          items: [
            'New: Calendar view — a List | Calendar toggle in the header switches to a Google Calendar-style month grid. Multi-day entries span across days as continuous bars, single entries show as colour-coded chips with times, tasks are marked, today is highlighted, and busy days collapse into "+N more"',
            "Click any entry in the calendar for details with Edit / Archive / Delete; click an empty day to prefill the add form's date; ‹ › and Today navigate months. Type filters and search apply to the calendar too. Your view choice is remembered per device",
          ],
        },
        {
          version: "v1.6.18",
          date: "August 10, 2026",
          latest: false,
          items: [
            "Fix (sync hardening after code review): restoring an entry from Trash or Archive no longer gets silently undone by the next sync — the restore now counts as the newest change",
            "Fix: devices that had custom task types from before v1.6.17 can no longer have them wiped by another device's settings on first sync",
            "Fix: a background sync no longer rebuilds an entry card you're editing (your typing is preserved), and changes saved while a sync is running are queued instead of silently skipped",
            'Fix: reconnecting Google mid-sync waits for the running sync so it can\'t create duplicate calendar events, and "Sync now" says so when a sync is already running',
            "Fix: switching Event/Task while offline now shows the warning instead of silently orphaning the old copy on Google",
            "Fix: custom-theme colours lost by the old beta data migration are recovered automatically",
          ],
        },
        {
          version: "v1.6.17",
          date: "August 10, 2026",
          latest: false,
          items: [
            "New: Cross-device sync — your entries, archive, trash, and task-type settings now follow you between devices and browsers through a hidden file in your own Google Drive. Connect the same Google account anywhere and everything merges automatically (newest change wins per entry; permanent deletes propagate too)",
            'Sync runs on app open and shortly after every change while connected; a "Sync now" button and last-synced time live in the Google Calendar modal. Themes and UI colours stay per-device on purpose. Reconnect once to grant the new Drive permission',
          ],
        },
        {
          version: "v1.6.16",
          date: "August 10, 2026",
          latest: false,
          items: [
            "Fix: modals no longer stretch to a fixed 540px height with empty space below their content — a leftover from the changelog's fixed-size styling was applying to every modal. Only the changelog keeps its fixed height (it scrolls inside); all other modals now size to their content",
          ],
        },
        {
          version: "v1.6.15",
          date: "August 10, 2026",
          latest: false,
          items: [
            'Fix: the Event/Task switch warning never appeared when the stored Google session had expired — the app treated the dead token as "connected", skipped the warning, and the old copy was orphaned silently. The switch now verifies the connection is actually live first, and an expired session shows the warning like a disconnected one',
          ],
        },
        {
          version: "v1.6.14",
          date: "August 10, 2026",
          latest: false,
          items: [
            "New: switch an entry between Event and Task while editing — no more delete-and-recreate. If Google is connected, the old calendar event (or task) is removed and the entry is recreated as the new kind automatically",
            "Switching a synced entry while disconnected now warns first — the old copy on Google couldn't be cleaned up, so the app asks you to connect (or not save) instead of leaving a duplicate behind",
          ],
        },
        {
          version: "v1.6.13",
          date: "August 4, 2026",
          latest: false,
          items: [
            'Fix: some entries kept failing to sync to Google Calendar with "Invalid start time" even with well-formed data -- caused by the GCal-side event being stuck in an all-day/timed mismatch that a normal update can\'t fix. It now recovers automatically by recreating the event fresh instead of failing every time',
          ],
        },
        {
          version: "v1.6.12",
          date: "July 31, 2026",
          latest: false,
          items: [
            'Fix: entries with a start time not in the app\'s picker (e.g. added via the AI Assistant or Import File) could get a malformed time and fail to sync to Google Calendar with "Invalid start time" -- times are now normalised everywhere an entry can be created or edited, not just from the time picker',
          ],
        },
        {
          version: "v1.6.11",
          date: "July 31, 2026",
          latest: false,
          items: [
            'Fix: Google Calendar/Tasks update and delete errors now show the real reason from Google instead of always guessing "token may have expired" — makes it possible to tell a genuine expired session from a permission or account mismatch',
          ],
        },
        {
          version: "v1.6.10",
          date: "July 31, 2026",
          latest: false,
          items: [
            "New: Clear Trash button in the Trash view — permanently deletes everything in Trash right away instead of waiting for the 5-day auto-purge (confirmation required)",
          ],
        },
        {
          version: "v1.6.9",
          date: "July 31, 2026",
          latest: false,
          items: [
            "Fix: Import duplicate check no longer looks at Trash — a re-imported entry that matches something you deleted is now added back instead of being silently skipped",
          ],
        },
        {
          version: "v1.6.8",
          date: "July 27, 2026",
          latest: false,
          items: [
            "Import File now skips duplicates — matches by original ID (JSON/CSV/Excel all carry it) or by name+deadline+time if no ID is present, so re-importing the same file twice won't create copies",
          ],
        },
        {
          version: "v1.6.7",
          date: "July 27, 2026",
          latest: false,
          items: [
            "New: Import File — sidebar button restores entries from your own JSON, CSV, or Excel exports. JSON restores everything; CSV/Excel restore name, type, deadline, time, remark only",
          ],
        },
        {
          version: "v1.6.6",
          date: "July 15, 2026",
          latest: false,
          items: [
            'Fix: the AI Assistant had no visibility into Trash at all -- asking it to check or restore trashed entries would incorrectly say "nothing there" or confuse Trash with Archive. It now sees Trash separately and can restore items from it directly',
          ],
        },
        {
          version: "v1.6.5",
          date: "July 15, 2026",
          latest: false,
          items: [
            'Fix: the Woodland and Dusty Pink themes\' "success" colour (used for the Archive button, connected-calendar pill, Sync All, and several other spots) was so pale it was nearly indistinguishable from the surrounding card and border colours -- both themes now use a clearly green success colour while keeping their muted look',
          ],
        },
        {
          version: "v1.6.4",
          date: "July 15, 2026",
          latest: false,
          items: [
            'Fix: task type chips in the "Tasks Needing Attention" modal were plain grey, ignoring your custom type colours -- they now match the colour-coded chips used everywhere else',
          ],
        },
        {
          version: "v1.6.3",
          date: "July 14, 2026",
          latest: false,
          items: [
            'Fix: the toast notification (e.g. "Settings saved.") used the page text colour as its background, which would render nearly invisible on the Twilight Sky and Neon Twilight themes -- it now uses the theme\'s accent colour pairing instead, the same guaranteed-contrast pair used by primary buttons, so it stays readable on every theme including custom ones',
          ],
        },
        {
          version: "v1.6.2",
          date: "July 14, 2026",
          latest: false,
          items: [
            "AI Assistant upgraded — now runs on a much stronger model (GPT-OSS-120B) via a secure proxy, so you no longer need to paste your own API key. It can take real actions with reliable tool-calling (add, edit, delete, archive, restore), do several at once, and remembers the conversation for follow-ups",
            "Fix: theme changes now preview live when you click them but require Save to keep — leaving Settings with an unsaved theme prompts you to save or discard, matching the rest of Settings",
          ],
        },
        {
          version: "v1.6.1",
          date: "July 13, 2026",
          latest: false,
          items: [
            "Fix: beta now keeps its own separate stored data instead of sharing localStorage with production (they were on the same origin on GitHub Pages) — your existing beta entries were copied over automatically, nothing was lost",
          ],
        },
        {
          version: "v1.6.0",
          date: "July 13, 2026",
          latest: false,
          items: [
            "Appearance Themes — choose from 6 designed themes (Default, Dark, Dusty Pink, Twilight Sky, Neon Twilight, Woodland), replacing the old 3-colour picker",
            "Custom Theme builder — shows the colours the active theme is using right now, edit any of them with instant preview",
            "Advanced Theme Settings — fine-tune all 24 individual colours (surfaces, borders, text tones, and every status/chip colour)",
            "Saved Themes — save your own custom themes with a name, then rename, apply, or delete them at any time",
          ],
        },
        {
          version: "v1.5.2",
          date: "July 2026",
          latest: false,
          items: [
            'Settings changes are now a draft until you click "Save changes" — edits to task types, colours, and interface theme no longer apply live; closing without saving reverts everything',
            "Leaving Settings with unsaved changes now prompts to save or discard instead of silently losing or keeping them",
            "Fixed a background scrollbar appearing behind the Settings panel — the page behind Settings no longer scrolls independently",
          ],
        },
        {
          version: "v1.5.1",
          date: "July 2026",
          latest: false,
          items: [
            "Multi-select task type filtering — click multiple type chips to filter by several types at once, instead of only one at a time",
          ],
        },
        {
          version: "v1.5.0",
          date: "July 2026",
          latest: false,
          items: [
            "Summary stat cards above filter bar — displays All Task, Entries, Archive, Today (due today + in progress), and Overdue counts",
            "Compact stat card design with reduced spacing for better visual integration",
          ],
        },
        {
          version: "v1.4.9",
          date: "July 2026",
          latest: false,
          items: [
            "Summary stat cards added above filter bar — displays All Task, Entries, Archive, Today (due today + in progress), and Overdue counts at a glance",
          ],
        },
        {
          version: "v1.4.8",
          date: "July 2026",
          latest: false,
          items: [
            "Summary stat cards added to the filter bar — displays Overdue, Today, and Soon entry counts at a glance",
          ],
        },
        {
          version: "v1.4.7",
          date: "July 2026",
          latest: false,
          items: [
            "Fix: rearrangeable task types now work for all types (built-in + custom), allow deletion of all types, and immediately update the type dropdown when you save changes",
          ],
        },
        {
          version: "v1.4.6",
          date: "July 2026",
          latest: false,
          items: [
            "Fix: sorting now automatically resets when toggling between entries and archive views — entries view defaults to descending (newest first), archive defaults to ascending (oldest first)",
          ],
        },
        {
          version: "v1.4.5",
          date: "July 2026",
          latest: false,
          items: [
            'Entry cards now display end time (timeTo) when set — shows "2:00PM → 5:30PM" for timed meetings/events that span multiple hours',
          ],
        },
        {
          version: "v1.4.4",
          date: "July 2026",
          latest: false,
          items: [
            "Archive view now defaults to ascending sort (oldest/completed entries first) when you switch to it — makes it more natural to review archived work chronologically",
          ],
        },
        {
          version: "v1.4.3",
          date: "July 2026",
          latest: false,
          items: [
            "Fix: deadline sorting now sub-sorts by time when multiple entries share the same date — entries on the same day now appear in chronological order (earliest time first)",
          ],
        },
        {
          version: "v1.4.2",
          date: "July 2026",
          latest: false,
          items: [
            'Fix: the "Calendar connected" pill trusted that a stored token meant a live connection — it now makes a quick check on page load and immediately flags "Reconnect" if the token has actually expired',
            "Fix: GCal event colour was frozen on each entry at creation/edit time — changing a type's colour in Settings now takes effect the next time existing entries are synced, instead of requiring you to re-edit every entry",
          ],
        },
        {
          version: "v1.4.1",
          date: "July 2026",
          latest: false,
          items: [
            "Fix: all 11 Google Calendar colour swatches in Settings were showing the wrong hex values — replaced with the actual colours Google Calendar uses today (Lavender, Sage, Grape, Flamingo, Banana, Tangerine, Peacock, Graphite, Blueberry, Basil, Tomato)",
          ],
        },
        {
          version: "v1.4.0",
          date: "July 2026",
          latest: false,
          items: [
            'Search now understands dates and times: "July 2", "02/07", "2/7/2026", "13:30", and "1:30 PM" all match — not just the exact stored date format',
            'Google Calendar: the pill now turns red and says "Reconnect Google Calendar" when your session token expires (after ~1 hour), instead of silently failing every sync in the background',
          ],
        },
        {
          version: "v1.3.1",
          date: "July 2026",
          latest: false,
          items: [
            'CRITICAL FIX: bulk delete (v1.2.9) wrote a "trashedAt" field instead of "deletedAt" — this crashed the entire Trash view whenever it contained a bulk-deleted entry, and caused those entries to be silently purged on the next page load. Fixed, plus a one-time migration for any entries already affected.',
          ],
        },
        {
          version: "v1.3.0",
          date: "July 2026",
          latest: false,
          items: [
            "Google Calendar: added a Disconnect button and a Reconnect button — previously the only way to disconnect was to clear browser storage manually",
            "Google Calendar: Client ID is now remembered, so Reconnect doesn't require re-pasting it",
            "Export Archive: added Export CSV/Excel/JSON for archived entries, matching the existing active-entries export",
          ],
        },
        {
          version: "v1.2.9",
          date: "July 2026",
          latest: false,
          items: [
            'Fix: bulk-delete confirm dialog said "permanently" even though entries were always moved to Trash — wording corrected',
            "Fix: bulk delete now also removes the linked Google Calendar event / Google Task, matching single-entry delete behavior",
            "Fix: monthly repeat (same day or same weekday of month) could generate a duplicate entry on the start date itself",
          ],
        },
        {
          version: "v1.2.8",
          date: "July 2026",
          latest: false,
          items: [
            "Fix: editing an entry showed 4 time picker boxes instead of 2 — initializeEditTimePickers() was being called twice (once from render(), once from startEdit())",
          ],
        },
        {
          version: "v1.2.7",
          date: "July 2026",
          latest: false,
          items: [
            "Fix: choosing a dark Surface color always forced text to white, ignoring the accent/text color you picked — removed the auto-contrast override so your chosen text color always applies",
          ],
        },
        {
          version: "v1.2.6",
          date: "July 2026",
          latest: false,
          items: [
            "Fix: time picker did not clear after adding an entry or clicking Clear form — the visible time trigger and selected hour/minute buttons kept showing the old time even though the hidden field was cleared",
          ],
        },
        {
          version: "v1.2.5",
          date: "July 2026",
          latest: false,
          items: [
            'CRITICAL FIX: restored toast(), openGCalModal(), and closeGCalModal() functions accidentally deleted during export rewrite — this had broken "Connect Google Calendar" and silently killed any code running after a toast() call (e.g. auto-sync to GCal on new entries)',
          ],
        },
        {
          version: "v1.2.4",
          date: "July 2026",
          latest: false,
          items: [
            "Excel export: header cells for Type/Deadline/Time now also centered (matching data rows)",
            "Excel export: added AutoFilter dropdowns on every column header, including Type, Deadline, and Date Created",
          ],
        },
        {
          version: "v1.2.3",
          date: "July 2026",
          latest: false,
          items: [
            "Switched Excel export from SheetJS to ExcelJS for full cell styling support",
            "Excel export: header row colored #60497A, body rows alternate #E4DFEC / #CCC0DA",
            "Excel export: Type/Deadline/Time columns centered, Date Created/Time Created/Updated right-aligned",
            "Deadline and Date Created now use DD/MM/YYYY format",
            "Updated column now shows DD/MM/YYYY , HH:mm:ss (full date + time of last edit)",
            "Time Created explicitly converted from UTC to GMT+7, independent of the viewer's system timezone",
          ],
        },
        {
          version: "v1.2.2",
          date: "July 2026",
          latest: false,
          items: [
            "Fix multi-select checkbox overlapping entry text — moved to end of card actions row",
          ],
        },
        {
          version: "v1.2.1",
          date: "July 2026",
          latest: false,
          items: [
            "Fix export: Date Created/Time Created/Updated columns were blank — now falls back to legacy created/updated fields",
            "Fix export: ID column showed scientific notation in Excel — now forced to text",
          ],
        },
        {
          version: "v1.2.0",
          date: "July 2026",
          latest: false,
          items: [
            "Multi-select mode: bulk archive and bulk delete with checkbox column",
            "Repeat entries: daily (every N days), weekly (pick days), monthly (same day or weekday), yearly, custom date picker",
            "Monthly repeat calendar preview with navigation and date toggles",
            "Fixed TDZ crash from let/const ordering in init",
            "Fixed monthly repeat skipping the starting month",
            "Fixed timezone bug in repeat date formatting",
            "Time picker UX: scroll-wheel clickable buttons with manual typing and auto-colon",
            "GCal duplicate prevention: PATCH if event exists, POST if new",
            "Silent sync mode suppresses per-entry toasts",
            "Added error surfacing in render and time picker init for diagnostics",
          ],
        },
        {
          version: "v1.1.9",
          date: "July 2026",
          latest: false,
          items: [
            "Fix TDZ crash - init() now runs after all let/const state declarations (Chrome strict-mode fix)",
            "Add error surfacing in render and time picker init to diagnose blank entries",
          ],
        },
        {
          version: "v1.1.8",
          date: "July 2026",
          latest: false,
          items: [
            "Diagnostic error messages: render() and initializeTimePickers() surface exceptions in UI and console",
          ],
        },
        {
          version: "v1.1.7",
          date: "July 2026",
          latest: false,
          items: [
            "Fix replaceChild crash in time picker init, fix GCAL_COLOR_OPTIONS TDZ error",
          ],
        },
        {
          version: "v1.1.6",
          date: "July 2026",
          latest: false,
          items: [
            "Fix JS crash from null element access, fix double style attribute on entry cards",
          ],
        },
        {
          version: "v1.1.5",
          date: "June 2026",
          latest: false,
          items: [
            "Multi-day event support with deadlineEnd field",
            "Repeat entry UI framework (buttons, calendar preview, modal)",
            "Multi-select framework (checkbox, bulk bar, SelectMode state)",
          ],
        },
        {
          version: "v1.1.0",
          date: "June 2026",
          latest: false,
          items: [
            "Custom scroll-wheel time picker (replaces native input type=time)",
            "Time picker auto-colon insertion and validation",
            "Restructured project folders: Project/Work Log/ (production), Project/Work Log Dev/ (development)",
            "Sync to index.html before every push (beta or production)",
            "GCal 24-color palette mapping with swatches in settings",
            "Added timeTo field for event end times",
          ],
        },
        {
          version: "v1.0.0",
          date: "June 2025",
          latest: false,
          items: [
            "Initial release: add, edit, delete entries with name, type, deadline, time, remark fields",
            "Google Calendar sync and Google Tasks sync with per-type colour mapping",
            "AI assistant via Groq (Llama 3.3 70B / 3.1 8B) with model switcher",
            "Archive system: entries move to archive instead of permanent delete, restorable",
            "Export to CSV (UTF-8 BOM for Thai), Excel (.xlsx via SheetJS), and JSON",
            "Filter by type chips, sort by newest/oldest/deadline/name with direction toggle",
            "Settings: task types, per-type colours, GCal colour IDs, UI accent/background colours",
            "Deadline date ranges for multi-day events; Sync All to GCal with auto-sync on connect",
            "localStorage persistence — private per browser",
          ],
        },
      ];
      let changelogPage = 0;

      function openChangelog() {
        changelogPage = 0;
        renderChangelog();
        document.getElementById("changelog-modal").classList.add("open");
      }
      function closeChangelog() {
        document.getElementById("changelog-modal").classList.remove("open");
      }
      function changelogNav(dir) {
        changelogPage = Math.max(
          0,
          Math.min(CHANGELOG.length - 1, changelogPage + dir),
        );
        renderChangelog();
      }
      function renderChangelog() {
        const v = CHANGELOG[changelogPage];
        const total = CHANGELOG.length;
        document.getElementById("cl-page-info").textContent =
          `${changelogPage + 1} / ${total}`;
        document.getElementById("cl-prev-btn").disabled =
          changelogPage >= total - 1;
        document.getElementById("cl-next-btn").disabled = changelogPage <= 0;
        document.getElementById("changelog-content").innerHTML = `
    <div class="cl-version">
      <div class="cl-version-header">${esc(v.version)} — ${esc(v.date)} <span class="cl-version-tag${v.latest ? "" : " old"}">${v.latest ? "Latest" : "Previous"}</span></div>
      <ul class="cl-items">${v.items.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>
    </div>`;
      }

      // ── Easter Egg: Creator Modal ──────────────────────────────────────────────
      let easterEggClicks = 0;
      let easterEggTimer = null;
      function easterEggClick() {
        easterEggClicks++;
        if (easterEggClicks === 1) {
          easterEggTimer = setTimeout(() => {
            easterEggClicks = 0;
          }, 2000);
        }
        if (easterEggClicks === 4) {
          clearTimeout(easterEggTimer);
          easterEggClicks = 0;
          document.getElementById("creator-modal").classList.add("open");
        }
      }
      function closeCreatorModal() {
        document.getElementById("creator-modal").classList.remove("open");
      }
      document
        .getElementById("creator-modal")
        ?.addEventListener("click", (e) => {
          if (e.target.id === "creator-modal") closeCreatorModal();
        });
      document
        .getElementById("settings-unsaved-modal")
        ?.addEventListener("click", (e) => {
          if (e.target.id === "settings-unsaved-modal") cancelUnsavedPrompt();
        });
      // Escape closes whichever layer is on top. Ordered top-down by z-index so a
      // confirm modal (100+) sitting over Settings (150 — but its unsaved-changes
      // prompt is a modal-overlay above it) closes before the layer beneath it,
      // and the mobile sidebar (90) / AI panel go last. Each entry: [id, closer].
      // Only the FIRST open layer closes per keypress — one Esc, one layer.
      const ESC_LAYERS = [
        ["settings-unsaved-modal", () => cancelUnsavedPrompt()],
        ["trash-confirm-modal", () => closeTrashConfirm()],
        ["creator-modal", () => closeCreatorModal()],
        ["changelog-modal", () => closeChangelog()],
        ["mode-switch-warn-modal", () => closeModeSwitchWarn()],
        ["cal-edit-modal", () => closeCalEditModal()],
        ["cal-quickadd-modal", () => closeCalQuickAdd()],
        ["cal-entry-modal", () => closeCalEntry()],
        ["cal-day-modal", () => closeCalDay()],
        ["gcal-modal", () => closeGCalModal()],
        ["repeat-modal-overlay", () => closeRepeatModal()],
        ["due-modal", () => closeDueModal()],
        ["trash-overlay", () => closeTrash()],
        ["settings-overlay", () => closeSettings()],
        ["sidebar", () => closeMobileSidebar()],
      ];
      function topOpenLayer() {
        for (const [id, close] of ESC_LAYERS) {
          const el = document.getElementById(id);
          if (!el) continue;
          const open =
            id === "sidebar"
              ? el.classList.contains("mobile-open")
              : el.classList.contains("open");
          if (open) return { el, close };
        }
        return null;
      }
      document.addEventListener("keydown", (e) => {
        if (e.key === "Escape") {
          // Don't steal Esc from an open <select> / datalist / the time picker
          // dropdown — those need it to dismiss themselves first.
          const tp = document.querySelector(".time-picker-modal.open");
          if (tp) {
            tp.classList.remove("open");
            return;
          }
          const top = topOpenLayer();
          if (top) {
            e.preventDefault();
            top.close();
          }
          return;
        }
        // Focus trap: Tab inside an open modal cycles within it instead of
        // escaping to the page underneath, which is invisible but still tabbable.
        if (e.key === "Tab") {
          const top = topOpenLayer();
          if (!top || top.el.id === "sidebar") return;
          const focusables = [
            ...top.el.querySelectorAll(
              'button:not([disabled]),[href],input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])',
            ),
          ].filter((x) => x.offsetParent !== null);
          if (!focusables.length) return;
          const first = focusables[0],
            last = focusables[focusables.length - 1];
          if (!top.el.contains(document.activeElement)) {
            e.preventDefault();
            first.focus();
            return;
          }
          if (e.shiftKey && document.activeElement === first) {
            e.preventDefault();
            last.focus();
          } else if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault();
            first.focus();
          }
        }
      });

      // ── AI Panel ───────────────────────────────────────────────────────────────
      const AI_PROXY_URL = "https://worklog-ai.phurint2283.workers.dev/";
      const AI_MODEL = "openai/gpt-oss-120b";
      let aiMessages = []; // conversation memory (user / assistant / tool turns)

      const AI_TOOLS = [
        {
          type: "function",
          function: {
            name: "add_entry",
            description: "Add a new work log entry (an event or a task).",
            parameters: {
              type: "object",
              properties: {
                name: { type: "string", description: "Title of the entry" },
                type: {
                  type: "string",
                  description:
                    "Task type, e.g. Meeting, Review, Report, Research, Other, or a custom type",
                },
                deadline: {
                  type: "string",
                  description:
                    "Start date (events) or due date (tasks), YYYY-MM-DD",
                },
                deadlineEnd: {
                  type: "string",
                  description:
                    "Optional end date for multi-day events, YYYY-MM-DD",
                },
                time: {
                  type: "string",
                  description: "Optional start time, HH:MM 24-hour",
                },
                timeTo: {
                  type: "string",
                  description: "Optional end time, HH:MM 24-hour",
                },
                remark: { type: "string", description: "Optional notes" },
                syncMode: {
                  type: "string",
                  enum: ["event", "task"],
                  description: '"event" (default) or "task"',
                },
              },
              required: ["name"],
            },
          },
        },
        {
          type: "function",
          function: {
            name: "edit_entry",
            description:
              "Edit an existing entry, identified by its numeric id.",
            parameters: {
              type: "object",
              properties: {
                id: {
                  type: "number",
                  description: "The numeric id of the entry to edit",
                },
                name: { type: "string" },
                type: { type: "string" },
                deadline: { type: "string" },
                deadlineEnd: { type: "string" },
                time: { type: "string" },
                timeTo: { type: "string" },
                remark: { type: "string" },
              },
              required: ["id"],
            },
          },
        },
        {
          type: "function",
          function: {
            name: "delete_entry",
            description: "Move an active entry to trash, by numeric id.",
            parameters: {
              type: "object",
              properties: { id: { type: "number" } },
              required: ["id"],
            },
          },
        },
        {
          type: "function",
          function: {
            name: "archive_entry",
            description: "Archive an active entry, by numeric id.",
            parameters: {
              type: "object",
              properties: { id: { type: "number" } },
              required: ["id"],
            },
          },
        },
        {
          type: "function",
          function: {
            name: "restore_entry",
            description:
              "Restore an archived entry back to active, by numeric id.",
            parameters: {
              type: "object",
              properties: { id: { type: "number" } },
              required: ["id"],
            },
          },
        },
        {
          type: "function",
          function: {
            name: "restore_from_trash",
            description:
              "Restore a deleted (trashed) entry back to active, by numeric id. Trash is separate from Archive -- entries land in trash via delete_entry, not archive_entry.",
            parameters: {
              type: "object",
              properties: { id: { type: "number" } },
              required: ["id"],
            },
          },
        },
      ];

      function buildContext() {
        const fmt = (e) =>
          `[id:${e.id}] "${e.name}" | type:${e.type || "--"} | ${e.syncMode === "task" ? "due" : "date"}:${e.deadline || "--"}${e.deadlineEnd ? " -> " + e.deadlineEnd : ""}${e.time ? " " + e.time : ""} | remark:${e.remark || "--"}`;
        const active = entries.length
          ? "ACTIVE ENTRIES:\n" + entries.map(fmt).join("\n")
          : "ACTIVE ENTRIES: (none)";
        const arch = archived.length
          ? "\n\nARCHIVED ENTRIES:\n" + archived.map(fmt).join("\n")
          : "";
        const trashed = trash.length
          ? "\n\nTRASH (deleted entries, auto-purged after 5 days):\n" +
            trash.map(fmt).join("\n")
          : "\n\nTRASH: (empty)";
        return active + arch + trashed;
      }

      function buildAISystemPrompt() {
        return `You are the assistant built into a personal "Work Log" app. You help the user query, summarise, and manage their work entries.\n\nToday's date is ${today()}.\n\nThere are three separate lists, and they are NOT interchangeable: ACTIVE (current work), ARCHIVED (put away on purpose via archive_entry/restore_entry), and TRASH (deleted via delete_entry, restored via restore_from_trash, auto-purged after 5 days). If the user says "trash" or "deleted", use the TRASH list and restore_from_trash -- do NOT use archive/restore_entry for that, and do not confuse the two lists when answering or acting.\n\nYou can take actions with the provided tools (add, edit, delete, archive, restore_entry, restore_from_trash). When the user asks for a change, call the right tool(s) with correct arguments -- you may call several tools to satisfy one request (e.g. restoring every item in trash). Use the numeric id shown in the lists below to target an existing entry. After acting, confirm briefly in plain language. For questions, answer directly from the lists below -- never guess or say something doesn't exist without checking the relevant list first. Keep replies concise and friendly.\n\nFormatting: reply in plain conversational sentences only -- NO markdown of any kind (no tables, no headings, no **bold**, no bullet lists, no asterisks). Write like a normal chat message. NEVER show the internal numeric id to the user (use ids only silently for tool calls) -- refer to entries by their name.\n\nAvailable task types: ${allTypes().join(", ")}.\nDates are YYYY-MM-DD; times are HH:MM (24-hour).\n\n${buildContext()}`;
      }

      function executeAITool(name, args) {
        const nowIso = new Date().toISOString();
        try {
          if (name === "add_entry") {
            const type = args.type || "";
            const entry = {
              id: Date.now() + Math.floor(Math.random() * 1000),
              name: args.name || "Untitled",
              type,
              deadline: args.deadline || "",
              deadlineEnd: args.deadlineEnd || "",
              time: padHM(args.time),
              timeTo: padHM(args.timeTo),
              remark: args.remark || "",
              color: typeColors[type] || null,
              gcalColorId: typeGCalIds[type] || undefined,
              syncMode: args.syncMode === "task" ? "task" : "event",
              createdAt: nowIso,
              updatedAt: nowIso,
            };
            entries.unshift(entry);
            pinnedId = entry.id;
            save();
            render();
            if (gcalToken && entry.deadline) {
              entry.syncMode === "task"
                ? pushToGTask(entry)
                : pushToGCal(entry);
            }
            return { ok: true, id: entry.id, message: `Added "${entry.name}"` };
          }
          if (name === "edit_entry") {
            const e =
              entries.find((x) => x.id === args.id) ||
              archived.find((x) => x.id === args.id);
            if (!e)
              return {
                ok: false,
                message: `No entry found with id ${args.id}`,
              };
            [
              "name",
              "type",
              "deadline",
              "deadlineEnd",
              "time",
              "timeTo",
              "remark",
            ].forEach((k) => {
              if (args[k] !== undefined && args[k] !== null)
                e[k] =
                  k === "time" || k === "timeTo" ? padHM(args[k]) : args[k];
            });
            if (args.type !== undefined) {
              e.color = typeColors[e.type] || null;
              e.gcalColorId = typeGCalIds[e.type] || undefined;
            }
            e.updatedAt = nowIso;
            save();
            render();
            if (gcalToken && e.deadline) {
              if (e.syncMode === "task" && e.gcalTaskId) patchGTask(e);
              else if (e.syncMode !== "task" && e.gcalEventId) patchGCal(e);
            }
            return { ok: true, message: `Updated "${e.name}"` };
          }
          if (name === "delete_entry") {
            const e = entries.find((x) => x.id === args.id);
            if (!e)
              return {
                ok: false,
                message: `No active entry with id ${args.id}`,
              };
            deleteEntry(args.id, true);
            return { ok: true, message: `Moved "${e.name}" to trash` };
          }
          if (name === "archive_entry") {
            const e = entries.find((x) => x.id === args.id);
            if (!e)
              return {
                ok: false,
                message: `No active entry with id ${args.id}`,
              };
            archiveEntry(args.id);
            return { ok: true, message: `Archived "${e.name}"` };
          }
          if (name === "restore_entry") {
            const e = archived.find((x) => x.id === args.id);
            if (!e)
              return {
                ok: false,
                message: `No archived entry with id ${args.id}`,
              };
            restoreEntry(args.id);
            return { ok: true, message: `Restored "${e.name}"` };
          }
          if (name === "restore_from_trash") {
            const e = trash.find((x) => x.id === args.id);
            if (!e)
              return {
                ok: false,
                message: `No trashed entry with id ${args.id}`,
              };
            restoreFromTrash(args.id);
            return { ok: true, message: `Restored "${e.name}" from trash` };
          }
          return { ok: false, message: `Unknown tool: ${name}` };
        } catch (err) {
          return { ok: false, message: "Error: " + err.message };
        }
      }

      function initAI() {
        const badge = document.getElementById("ai-model-badge");
        if (badge) {
          badge.textContent = "Ready";
          badge.style.color = "var(--success)";
        }
      }

      function toggleAI() {
        const p = document.getElementById("ai-panel");
        p.classList.toggle("open");
        if (p.classList.contains("open"))
          document.getElementById("ai-input")?.focus();
      }

      function aiSuggest(text) {
        document.getElementById("ai-input").value = text;
        sendAI();
      }

      function clearAIChat() {
        aiMessages = [];
        document.getElementById("ai-messages").innerHTML =
          '<div class="ai-msg bot">Chat cleared. How can I help with your work log?</div>';
      }

      async function sendAI() {
        const input = document.getElementById("ai-input");
        const text = input.value.trim();
        if (!text) return;
        input.value = "";
        appendMsg(text, "user");
        aiMessages.push({ role: "user", content: text });
        const loadId = appendMsg("Thinking...", "bot loading");
        try {
          let guard = 0;
          while (guard++ < 6) {
            const resp = await fetch(AI_PROXY_URL, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                model: AI_MODEL,
                messages: [
                  { role: "system", content: buildAISystemPrompt() },
                  ...aiMessages,
                ],
                tools: AI_TOOLS,
                tool_choice: "auto",
                temperature: 0.3,
              }),
            });
            const data = await resp.json();
            if (data.error) {
              removeMsg(loadId);
              appendMsg(
                "Error: " + (data.error.message || JSON.stringify(data.error)),
                "bot",
              );
              return;
            }
            const msg =
              data.choices && data.choices[0] && data.choices[0].message;
            if (!msg) {
              removeMsg(loadId);
              appendMsg("No response from the AI.", "bot");
              return;
            }
            aiMessages.push({
              role: "assistant",
              content: msg.content || "",
              tool_calls: msg.tool_calls,
            });
            if (msg.tool_calls && msg.tool_calls.length) {
              for (const tc of msg.tool_calls) {
                let args = {};
                try {
                  args = JSON.parse(tc.function.arguments || "{}");
                } catch (e) {}
                const result = executeAITool(tc.function.name, args);
                aiMessages.push({
                  role: "tool",
                  tool_call_id: tc.id,
                  content: JSON.stringify(result),
                });
              }
              continue;
            }
            removeMsg(loadId);
            appendMsg(msg.content || "(done)", "bot");
            return;
          }
          removeMsg(loadId);
          appendMsg(
            "Stopped after too many steps -- please try rephrasing.",
            "bot",
          );
        } catch (err) {
          removeMsg(loadId);
          appendMsg(
            "Could not reach the AI service. Check your internet connection.",
            "bot",
          );
        }
      }

      let msgCounter = 0;
      function appendMsg(text, cls) {
        const id = "msg-" + ++msgCounter;
        const msgs = document.getElementById("ai-messages");
        const div = document.createElement("div");
        div.className = "ai-msg " + cls;
        div.id = id;
        div.textContent = text;
        msgs.appendChild(div);
        msgs.scrollTop = msgs.scrollHeight;
        return id;
      }
      function removeMsg(id) {
        document.getElementById(id)?.remove();
      }

      // ── Themes ───────────────────────────────────────────────────────────────────
      // Every themeable CSS variable. tier:'basic' shows in the always-visible grid;
      // tier:'adv' shows under "Advanced Theme Settings", grouped by `group`.
      const THEME_TOKENS = [
        { key: "bg", label: "Background", tier: "basic" },
        { key: "surface", label: "Surface", tier: "basic" },
        { key: "accent", label: "Accent", tier: "basic" },
        { key: "text", label: "Text", tier: "basic" },
        {
          key: "surface2",
          label: "Surface (alt)",
          tier: "adv",
          group: "Surfaces & borders",
        },
        {
          key: "border",
          label: "Border",
          tier: "adv",
          group: "Surfaces & borders",
        },
        {
          key: "border2",
          label: "Border (strong)",
          tier: "adv",
          group: "Surfaces & borders",
        },
        {
          key: "text2",
          label: "Text (muted)",
          tier: "adv",
          group: "Text tones",
        },
        {
          key: "text3",
          label: "Text (faint)",
          tier: "adv",
          group: "Text tones",
        },
        {
          key: "accent-text",
          label: "Accent text",
          tier: "adv",
          group: "Text tones",
        },
        {
          key: "success",
          label: "Success",
          tier: "adv",
          group: "Status — success",
        },
        {
          key: "success-bg",
          label: "Success bg",
          tier: "adv",
          group: "Status — success",
        },
        { key: "info", label: "Info", tier: "adv", group: "Status — info" },
        {
          key: "info-bg",
          label: "Info bg",
          tier: "adv",
          group: "Status — info",
        },
        {
          key: "warn",
          label: "Warning",
          tier: "adv",
          group: "Status — warning",
        },
        {
          key: "warn-bg",
          label: "Warning bg",
          tier: "adv",
          group: "Status — warning",
        },
        {
          key: "danger",
          label: "Danger",
          tier: "adv",
          group: "Status — danger",
        },
        {
          key: "danger-bg",
          label: "Danger bg",
          tier: "adv",
          group: "Status — danger",
        },
        {
          key: "today",
          label: "Today chip",
          tier: "adv",
          group: "Status — today",
        },
        {
          key: "today-text",
          label: "Today chip text",
          tier: "adv",
          group: "Status — today",
        },
        {
          key: "last-day",
          label: "Last day chip",
          tier: "adv",
          group: "Status — last day",
        },
        {
          key: "last-day-text",
          label: "Last day chip text",
          tier: "adv",
          group: "Status — last day",
        },
        {
          key: "task-mode",
          label: "Task mode chip",
          tier: "adv",
          group: "Status — task mode",
        },
        {
          key: "task-mode-bg",
          label: "Task mode chip bg",
          tier: "adv",
          group: "Status — task mode",
        },
      ];

      let savedThemes = JSON.parse(
        localStorage.getItem("wl2dev_saved_themes") || "[]",
      );

      function normalizeHex(v) {
        v = (v || "").trim();
        if (!v) return "#000000";
        const rgb = v.match(/rgba?\(([^)]+)\)/i);
        if (rgb) {
          const parts = rgb[1].split(",").map((x) => parseInt(x.trim()));
          return (
            "#" +
            parts
              .slice(0, 3)
              .map((n) => (n || 0).toString(16).padStart(2, "0"))
              .join("")
          );
        }
        if (v[0] !== "#") v = "#" + v;
        if (/^#[0-9a-fA-F]{3}$/.test(v))
          v = "#" + v[1] + v[1] + v[2] + v[2] + v[3] + v[3];
        return /^#[0-9a-fA-F]{6}$/.test(v) ? v.toLowerCase() : "#000000";
      }

      // Read the colour every token currently resolves to (inline overrides + theme class).
      function readCurrentTokens() {
        const cs = getComputedStyle(document.documentElement);
        const out = {};
        THEME_TOKENS.forEach((t) => {
          out[t.key] = normalizeHex(cs.getPropertyValue("--" + t.key));
        });
        return out;
      }

      function clearThemeOverrides() {
        const root = document.documentElement;
        THEME_TOKENS.forEach((t) => root.style.removeProperty("--" + t.key));
      }

      function applyTokenSet(tokens) {
        const root = document.documentElement;
        THEME_TOKENS.forEach((t) => {
          if (tokens[t.key])
            root.style.setProperty("--" + t.key, tokens[t.key]);
        });
      }

      // Switch to one of the built-in preset themes.
      function switchTheme(themeName) {
        clearThemeOverrides();
        document.documentElement.className =
          themeName === "default" ? "" : "theme-" + themeName;
        pendingTheme = themeName;
        pendingCustomEdited = false;
        settingsDirty = true;
        markActiveTheme();
        populateCustomFromCurrent();
        renderSavedThemes();
      }

      // Highlight whichever preset button matches the stored theme.
      function markActiveTheme() {
        const cur = activeThemeName();
        document
          .querySelectorAll(".theme-btn")
          .forEach((b) => b.classList.remove("active"));
        if (!cur.startsWith("saved:")) {
          document
            .querySelector(`.theme-btn[data-theme="${cur}"]`)
            ?.classList.add("active");
        }
      }

      // ── Custom theme editor ──
      // Build the colour pickers (basic grid + advanced grouped panel) from THEME_TOKENS.
      function pickerHTML(t) {
        return `<div class="color-picker-group">
    <label class="color-picker-label" for="tk-${t.key}">${t.label}</label>
    <div class="color-picker-input">
      <input type="color" id="tk-${t.key}" oninput="onTokenColor('${t.key}')"/>
      <input type="text" id="tk-${t.key}-hex" onchange="onTokenHex('${t.key}')" placeholder="#000000"/>
    </div>
  </div>`;
      }

      function buildCustomEditor() {
        const basicWrap = document.getElementById("custom-basic-grid");
        const advWrap = document.getElementById("advanced-token-groups");
        if (!basicWrap || !advWrap) return;
        basicWrap.innerHTML = THEME_TOKENS.filter((t) => t.tier === "basic")
          .map(pickerHTML)
          .join("");
        const groups = {};
        THEME_TOKENS.filter((t) => t.tier === "adv").forEach((t) => {
          (groups[t.group] = groups[t.group] || []).push(t);
        });
        advWrap.innerHTML = Object.keys(groups)
          .map(
            (g) =>
              `<div class="adv-group-label">${g}</div>
     <div class="custom-theme-grid">${groups[g].map(pickerHTML).join("")}</div>`,
          )
          .join("");
      }

      // Fill every picker with the colour the active theme uses right now.
      function populateCustomFromCurrent() {
        const tokens = readCurrentTokens();
        THEME_TOKENS.forEach((t) => {
          const c = document.getElementById("tk-" + t.key);
          const h = document.getElementById("tk-" + t.key + "-hex");
          if (c) c.value = tokens[t.key];
          if (h) h.value = tokens[t.key];
        });
      }

      // Live-apply an edit so the whole app previews the change immediately.
      function onTokenColor(key) {
        const v = document.getElementById("tk-" + key).value;
        document.getElementById("tk-" + key + "-hex").value = v;
        document.documentElement.style.setProperty("--" + key, v);
        pendingCustomEdited = true;
        settingsDirty = true;
      }
      function onTokenHex(key) {
        const v = normalizeHex(
          document.getElementById("tk-" + key + "-hex").value,
        );
        document.getElementById("tk-" + key).value = v;
        document.getElementById("tk-" + key + "-hex").value = v;
        document.documentElement.style.setProperty("--" + key, v);
        pendingCustomEdited = true;
        settingsDirty = true;
      }

      function toggleAdvancedTheme() {
        const panel = document.getElementById("advanced-theme-panel");
        const btn = document.getElementById("advanced-toggle-btn");
        const opening = panel.style.display === "none" || !panel.style.display;
        panel.style.display = opening ? "block" : "none";
        btn.classList.toggle("open", opening);
      }

      // Revert unsaved tweaks back to the active theme's colours.
      function resetCustomForm() {
        const cur = activeThemeName();
        clearThemeOverrides();
        if (cur.startsWith("saved:")) {
          const th = savedThemes.find((t) => "saved:" + t.id === cur);
          if (th) applyTokenSet(th.tokens);
        }
        populateCustomFromCurrent();
      }

      // ── Saved themes ──
      function saveCustomTheme() {
        const nameInput = document.getElementById("custom-theme-name");
        let name = (nameInput.value || "").trim();
        if (!name) name = "My Theme " + (savedThemes.length + 1);
        const tokens = readCurrentTokens();
        const id = "t" + Date.now();
        savedThemes.push({ id, name, tokens });
        localStorage.setItem(
          "wl2dev_saved_themes",
          JSON.stringify(savedThemes),
        );
        nameInput.value = "";
        applySavedTheme(id);
        toast('Theme "' + name + '" saved');
      }

      function applySavedTheme(id) {
        const th = savedThemes.find((t) => t.id === id);
        if (!th) return;
        clearThemeOverrides();
        document.documentElement.className = "theme-custom";
        applyTokenSet(th.tokens);
        pendingTheme = "saved:" + id;
        pendingCustomEdited = false;
        settingsDirty = true;
        markActiveTheme();
        populateCustomFromCurrent();
        renderSavedThemes();
      }

      function deleteSavedTheme(id) {
        savedThemes = savedThemes.filter((t) => t.id !== id);
        localStorage.setItem(
          "wl2dev_saved_themes",
          JSON.stringify(savedThemes),
        );
        if (activeThemeName() === "saved:" + id) {
          switchTheme("default");
        }
        renderSavedThemes();
        toast("Theme deleted");
      }

      function renameSavedTheme(id, value) {
        const th = savedThemes.find((t) => t.id === id);
        if (!th) return;
        th.name = (value || "").trim() || th.name;
        localStorage.setItem(
          "wl2dev_saved_themes",
          JSON.stringify(savedThemes),
        );
      }

      function renderSavedThemes() {
        const list = document.getElementById("saved-themes-list");
        if (!list) return;
        if (!savedThemes.length) {
          list.innerHTML =
            '<div class="saved-empty">No saved themes yet. Adjust the colours above and click Save Custom Theme.</div>';
          return;
        }
        const cur = activeThemeName();
        list.innerHTML = savedThemes
          .map((th) => {
            const active = cur === "saved:" + th.id;
            const sw = ["bg", "surface", "accent", "text"]
              .map(
                (k) =>
                  `<div class="theme-color" style="background:${th.tokens[k] || "#ccc"}"></div>`,
              )
              .join("");
            return `<div class="saved-theme-row${active ? " active" : ""}">
      <div class="theme-preview saved">${sw}</div>
      <input class="saved-theme-name" value="${esc(th.name)}" onchange="renameSavedTheme('${th.id}', this.value)"/>
      <button class="btn btn-sm${active ? " btn-primary" : ""}" onclick="applySavedTheme('${th.id}')">${active ? "Active" : "Apply"}</button>
      <button class="icon-btn del" onclick="deleteSavedTheme('${th.id}')" title="Delete theme">
        <svg class="icon sm" viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/></svg>
      </button>
    </div>`;
          })
          .join("");
      }

      // Apply the stored theme on page load (no UI side-effects — settings isn't built yet).
      function loadTheme() {
        const cur = localStorage.getItem("wl2dev_current_theme") || "default";
        clearThemeOverrides();
        if (cur === "custom") {
          const tokens = JSON.parse(
            localStorage.getItem("wl2dev_custom_tokens") || "{}",
          );
          document.documentElement.className = "theme-custom";
          applyTokenSet(tokens);
          return;
        }
        if (cur.startsWith("saved:")) {
          const th = savedThemes.find((t) => "saved:" + t.id === cur);
          if (th) {
            document.documentElement.className = "theme-custom";
            applyTokenSet(th.tokens);
            return;
          }
          document.documentElement.className = "";
          return;
        }
        document.documentElement.className =
          cur === "default" ? "" : "theme-" + cur;
      }

      // ── Bootstrap ────────────────────────────────────────────────────────────────
      // Run init() here, at the very end, so all let/const state above is initialized.
      loadTheme();
      init();
      initAI();
