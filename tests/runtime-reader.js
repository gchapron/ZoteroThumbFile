/* Runs only through the project's disposable Zotero test harness. */
const assert = (condition, message) => { if (!condition) throw new Error(message); };
assert(Zotero.Profile.dir.endsWith("/work/test-profile"), "Use only the disposable test profile");
window = Zotero.getMainWindow();
const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
const pluginID = "pdf-page-thumbnails@zotero-visual-plugins.local";
const preference = "extensions.zotero.pdfPageThumbnails.autoOpen";
const addon = await AddonManager.getAddonByID(pluginID);
assert(addon?.isActive && addon.version === "1.1.5", "ZoteroThumbFile 1.1.5 must be installed");
const evidence = [];
const waitFor = async (check, label) => {
  for (let i = 0; i < 150; i++) { if (check()) return; await delay(100); }
  throw new Error("Timed out: " + label);
};
Services.prefs.setBoolPref(preference, true);
Services.prefs.setIntPref("extensions.zotero.pdfPageThumbnails.size", 200);
let stressID = Zotero.Prefs.get("visualTestContactSheet80ID");
if (!stressID || !Zotero.Items.get(stressID)) {
  let attachment = await Zotero.Attachments.importFromFile({
    file: Zotero.Profile.dir.replace(/test-profile$/, "test-harness/eighty-pages.pdf"),
    title: "Contact Sheet Test — 80 pages with mixed orientations", contentType: "application/pdf"
  });
  stressID = attachment.id;
  Zotero.Prefs.set("visualTestContactSheet80ID", stressID);
}
const reader = await Zotero.Reader.open(stressID, null, { allowDuplicate: true });
await reader._initPromise;
const hostDoc = reader._iframeWindow.document;
await waitFor(() => hostDoc.getElementById("zvp-contact-frame")?.contentDocument?.getElementById("zvp-contact-sheet"), "contact sheet frame mount");
const frame = hostDoc.getElementById("zvp-contact-frame");
const doc = frame.contentDocument;
const sheet = doc.getElementById("zvp-contact-sheet");
const scroll = doc.getElementById("zvp-contact-scroll");
const grid = doc.getElementById("zvp-contact-grid");
const slider = doc.getElementById("zvp-contact-size");
const button = hostDoc.getElementById("zvp-page-thumbnails-toggle");
await waitFor(() => sheet?.getAttribute("data-page-count") === "80" && doc.querySelector(".zvp-contact-page img"), "80-page contact sheet initial rendering");
assert(!sheet.hidden, "Contact sheet opens automatically");
const header = doc.querySelector('.zvp-contact-header');
const headerRect = header.getBoundingClientRect();
assert(headerRect.height === 32, "Contact-sheet toolbar is exactly 32px including its border");
assert(!header.querySelector('.zvp-contact-heading,strong'), "No visible Contact Sheet heading remains");
assert(!header.textContent.includes('Contact Sheet'), "Toolbar has no visible Contact Sheet title");
assert(sheet.getAttribute('aria-label') === 'PDF Contact Sheet', "Contact sheet retains its accessible name");
assert(header.querySelector('.zvp-contact-status').textContent === '80 pages', "Toolbar shows a concise page count");
for (let control of header.querySelectorAll('input,output,button')) {
  let rect=control.getBoundingClientRect();
  assert(rect.top>=headerRect.top && rect.bottom<=headerRect.bottom, "Compact controls fit within the 32px toolbar");
}
const closeButton = header.querySelector('.zvp-contact-close');
assert(closeButton.getBoundingClientRect().height === 24 && closeButton.getBoundingClientRect().width === 24, "Close control is exactly 24 by 24 pixels");
assert(closeButton.textContent.trim() === "" && closeButton.querySelector('svg path'), "Close control shows only the cross icon");
assert(closeButton.getAttribute('aria-label') === 'Close contact sheet', "Icon-only close control has an accessible name");
assert(closeButton.getAttribute('title').includes('Escape'), "Close control tooltip explains its keyboard shortcut");
closeButton.click();
assert(frame.hidden && sheet.hidden, "Close icon returns to the native PDF reader");
button.click();
await waitFor(() => !frame.hidden && !sheet.hidden, "reopen after close icon");
evidence.push("Compact 32px toolbar removes the visible title, fits every control, and provides a named 24px icon-only close button");
assert(frame.getBoundingClientRect().width >= reader._iframeWindow.innerWidth - 2, "Contact sheet spans reader width");
assert(frame.getBoundingClientRect().height >= reader._iframeWindow.innerHeight - 45, "Contact sheet spans reader content height");
assert(+grid.getAttribute("data-columns") > 1, "Contact sheet has multiple columns");
assert(doc.querySelectorAll(".zvp-contact-page").length < 80, "Long document uses virtualized cards");
const sidebarState = { open: reader._internalReader._state.sidebarOpen, view: reader._internalReader._state.sidebarView };
const initial = { columns: +grid.getAttribute("data-columns"), mountedCards: doc.querySelectorAll(".zvp-contact-page").length, scrollHeight: scroll.scrollHeight, viewportHeight: scroll.clientHeight };
assert(initial.scrollHeight > initial.viewportHeight * 4, "All 80 pages contribute to full scroll height");
evidence.push("80-page PDF automatically opens as a full-reader, multi-column virtualized contact sheet");
assert(slider.step === "any", "Thumbnail slider supports continuous input");
const continuousPreview = doc.querySelector('.zvp-contact-page[data-page-index="0"] img');
slider.value = "237.25";
slider.dispatchEvent(new doc.defaultView.Event("input", {bubbles:true}));
await delay(35);
assert(slider.value === "237.25", "Continuous slider retains a fractional input without 10px snapping");
assert(parseFloat(doc.querySelector('.zvp-contact-page[data-page-index="0"]').style.width) === 261.25, "Fractional thumbnail size reaches the live grid geometry");
assert(Services.prefs.getIntPref("extensions.zotero.pdfPageThumbnails.size") === 237, "Only the stored integer preference is rounded");
assert(doc.querySelector('.zvp-contact-zoom output').textContent === "237 px", "Visible size label stays concise");
assert(doc.querySelector('.zvp-contact-page[data-page-index="0"] img') === continuousPreview, "Continuous resizing preserves the visible preview");
slider.value = "200";
slider.dispatchEvent(new doc.defaultView.Event("input", {bubbles:true}));
await delay(150);
evidence.push("Continuous slider retains 237.25px geometry with no fixed step; display and saved preference alone round to 237px");

// Regression: zoom must keep each previous image painted while sharper images
// are rendered, then swap only after their decoding is complete.
await waitFor(() => doc.querySelector('.zvp-contact-page[data-page-index="0"] img')?.naturalWidth > 0, "initial zoom preview");
const zoomCell = doc.querySelector('.zvp-contact-page[data-page-index="0"] .zvp-contact-image');
const originalPreview = zoomCell.querySelector('img');
let blankZoomFrames = 0;
const zoomObserver = new doc.defaultView.MutationObserver(() => {
  const image = zoomCell.querySelector('img');
  if (!image || !image.complete || !image.naturalWidth) blankZoomFrames++;
});
zoomObserver.observe(zoomCell, Components.utils.cloneInto({childList:true},doc.defaultView));
for (let size of [210,230,270,310,350,390]) {
  slider.value=String(size);
  slider.dispatchEvent(new doc.defaultView.Event('input',{bubbles:true}));
  await delay(20);
  assert(zoomCell.querySelector('img') === originalPreview && originalPreview.complete && originalPreview.naturalWidth > 0, 'Existing preview stays mounted and visible throughout rapid zoom');
}
await waitFor(() => zoomCell.querySelector('img')?.naturalWidth === 780, "decoded final zoom raster");
assert(zoomCell.querySelector('img')!==originalPreview,'Sharper preview replaces old image after zoom settles');
assert(blankZoomFrames===0,'No blank or undecoded image replacement during zoom');
zoomObserver.disconnect();
evidence.push("Rapid zoom retains the same visible thumbnail until the new raster is decoded, then replaces it atomically with zero blank frames");

slider.value = "100";
slider.dispatchEvent(new doc.defaultView.Event("input", { bubbles: true }));
await delay(150);
let smallColumns = +grid.getAttribute("data-columns");
slider.value = "400";
slider.dispatchEvent(new doc.defaultView.Event("input", { bubbles: true }));
await waitFor(() => +grid.getAttribute("data-columns") < smallColumns && doc.querySelector('.zvp-contact-page[data-page-index="0"] img')?.naturalWidth >= 700, "large high-resolution previews");
let largeColumns = +grid.getAttribute("data-columns");
let largeWidth = doc.querySelector('.zvp-contact-page[data-page-index="0"] img').naturalWidth;
assert(largeWidth >= 700, "Zoom re-renders high resolution, rather than enlarging 120px native sidebar previews");
evidence.push("100–400px slider changes grid columns and re-renders large previews at retina resolution");

scroll.scrollTop = scroll.scrollHeight;
await waitFor(() => doc.querySelector('.zvp-contact-page[data-page-index="79"] img')?.naturalWidth > 0, "last page image");
const last = doc.querySelector('.zvp-contact-page[data-page-index="79"]');
const lastScroll = scroll.scrollTop;
assert(last.getBoundingClientRect().bottom <= scroll.getBoundingClientRect().bottom + 2, "Last page is reachable at bottom");
assert(doc.querySelectorAll(".zvp-contact-page").length < 20, "Virtualization stays bounded at end of 80-page PDF");
last.click();
await waitFor(() => sheet.hidden && reader._internalReader._state.primaryViewStats.pageIndex === 79, "last page navigation");
assert(reader._internalReader._state.sidebarOpen === sidebarState.open && reader._internalReader._state.sidebarView === sidebarState.view, "Native sidebar state unchanged");
button.click();
await waitFor(() => !sheet.hidden && doc.querySelector('.zvp-contact-page[data-page-index="79"] img'), "return to contact sheet");
assert(Math.abs(scroll.scrollTop - lastScroll) <= 2, "Returning to contact sheet preserves scroll position");
evidence.push("Scroll reaches page 80, selecting it opens native reader page 80, and returning preserves contact-sheet scroll");
evidence.push("Native reader sidebar and annotations layout are preserved");

// Discover one landscape page in the mixed-orientation fixture.
let landscapeIndex = -1;
const pdfWindow = reader._internalReader._primaryView._iframeWindow;
for (let index = 0; index < 12; index++) {
  let page = Components.utils.waiveXrays(await pdfWindow.PDFViewerApplication.pdfDocument.getPage(index + 1));
  let viewport = page.getViewport(Components.utils.cloneInto({scale:1},pdfWindow));
  if (viewport.width > viewport.height) { landscapeIndex = index; break; }
}
assert(landscapeIndex >= 0, "Fixture contains a landscape page");
scroll.scrollTop = Math.floor(landscapeIndex / largeColumns) * (Math.ceil(400 * Math.SQRT2) + 58);
await waitFor(() => doc.querySelector(`.zvp-contact-page[data-page-index="${landscapeIndex}"] img`)?.naturalWidth > 0, "landscape preview");
let landscape = doc.querySelector(`.zvp-contact-page[data-page-index="${landscapeIndex}"] img`);
assert(landscape.naturalWidth > landscape.naturalHeight, "Landscape PDF pages retain correct aspect ratio");
evidence.push("Mixed portrait and landscape pages keep their aspect ratios");

sheet.dispatchEvent(new doc.defaultView.KeyboardEvent("keydown", { key: "-", metaKey: true, bubbles: true }));
assert(slider.value === "380", "Command-minus reduces thumbnail size");
sheet.dispatchEvent(new doc.defaultView.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
assert(sheet.hidden, "Escape returns to normal reader");
button.click();
// Rapid close/reopen while rendering exercises cancellation of same-key tasks.
button.click(); button.click();
await waitFor(() => [...doc.querySelectorAll('.zvp-contact-page')].every(x => x.querySelector('img')), "rapid close/reopen does not strand loading cards");
evidence.push("Keyboard zoom/Escape and rapid close/reopen cancellation work");

// Real annotation safety: native reader listens for Delete on window capture.
// Keyboard events in our separate browsing context must never reach it.
const annotation = await Zotero.Annotations.saveFromJSON(Zotero.Items.get(stressID), {
  key: Zotero.DataObjectUtilities.generateKey(), type: "note", comment: "Contact sheet keyboard safety fixture",
  color: "#ffd400", pageLabel: "1", sortIndex: "00000|000000|00000",
  position: { pageIndex: 0, rects: [[20,20,40,40]] }
});
await waitFor(() => reader._internalReader._state.annotations.some(x => x.id === annotation.key), "annotation reaches reader");
scroll.focus();
reader._internalReader.setSelectedAnnotations(Components.utils.cloneInto([annotation.key],reader._iframeWindow));
assert(reader._internalReader._state.selectedAnnotationIDs.includes(annotation.key), "Underlying annotation is selected before keyboard safety test");
let parentKeyEvents = 0;
const countParent = () => parentKeyEvents++;
hostDoc.defaultView.addEventListener("keydown",countParent,true);
for (let key of ["Delete","Backspace"]) scroll.dispatchEvent(new doc.defaultView.KeyboardEvent("keydown",{key,bubbles:true,cancelable:true}));
await delay(150);
assert(parentKeyEvents === 0, "Contact-sheet delete keys do not reach native reader capture handlers");
assert(Zotero.Items.exists(annotation.id) && reader._internalReader._state.annotations.some(x=>x.id===annotation.key), "Selected native annotation survives Delete and Backspace");
let nativeScale = reader._internalReader._primaryView._iframeWindow.PDFViewerApplication.pdfViewer.currentScale;
let previousSize = +slider.value;
scroll.dispatchEvent(new doc.defaultView.KeyboardEvent("keydown",{key:"-",metaKey:true,bubbles:true,cancelable:true}));
assert(+slider.value === previousSize - 20, "Grid zoom command is handled inside contact sheet");
assert(reader._internalReader._primaryView._iframeWindow.PDFViewerApplication.pdfViewer.currentScale === nativeScale, "Grid zoom leaves native PDF scale unchanged");
for (let i=0;i<12;i++) {
  let active=doc.activeElement;
  active.dispatchEvent(new doc.defaultView.KeyboardEvent("keydown",{key:"Tab",shiftKey:i>5,bubbles:true,cancelable:true}));
  assert(sheet.contains(doc.activeElement),"Tab focus remains inside contact sheet");
}
hostDoc.defaultView.removeEventListener("keydown",countParent,true);
await annotation.eraseTx();
evidence.push("Isolated keyboard keeps selected native annotations intact on Delete/Backspace; Cmd zoom changes only the grid; Tab stays within contact sheet");

const menu = window.document.getElementById("zvp-page-thumbnails-auto-open");
menu.doCommand();
await waitFor(() => !Services.prefs.getBoolPref(preference), "Tools preference disables auto-open");
const second = await Zotero.Reader.open(fixture.attachmentID, null, { allowDuplicate: true });
await second._initPromise;
await delay(300);
const secondHostDoc = second._iframeWindow.document;
await waitFor(() => secondHostDoc.getElementById("zvp-contact-frame")?.contentDocument?.getElementById("zvp-contact-sheet"), "second frame mount");
const secondDoc = secondHostDoc.getElementById("zvp-contact-frame").contentDocument;
assert(secondDoc.getElementById("zvp-contact-sheet").hidden, "Manual-only preference applies to new PDF");
secondHostDoc.getElementById("zvp-page-thumbnails-toggle").click();
await waitFor(() => secondDoc.querySelectorAll('.zvp-contact-page img').length === 3, "manual opening renders all three pages");
evidence.push("Tools preference allows manual opening of new PDFs");

Zotero.Reader.registerEventListener("renderToolbar", () => {}, "zvp-contact-sentinel");
await addon.disable();
await delay(200);
for (let d of [hostDoc, secondHostDoc]) {
  assert(!d.getElementById("zvp-contact-frame") && !d.getElementById("zvp-page-thumbnails-toggle"), "Disable removes all injected reader UI");
}
assert(!window.document.getElementById("zvp-page-thumbnails-auto-open"), "Disable removes Tools preference");
assert(Zotero.Reader._registeredListeners.some(x => x.pluginID === "zvp-contact-sentinel"), "Other plugin listener survives");
Zotero.Reader._unregisterEventListenerByPluginID("zvp-contact-sentinel");
Services.prefs.setBoolPref(preference, true);
await addon.enable();
await waitFor(() => secondHostDoc.getElementById("zvp-contact-frame")?.contentDocument.querySelectorAll('.zvp-contact-page img').length === 3, "re-enable existing PDF");
evidence.push("Disable cleans overlays/styles/controls; re-enable works in existing PDFs without removing other plugins' listeners");

const separate = await Zotero.Reader.open(fixture.attachmentID, null, { openInWindow: true });
await separate._initPromise;
await waitFor(() => separate._iframeWindow.document.getElementById('zvp-contact-frame')?.contentDocument.querySelectorAll('.zvp-contact-page img').length === 3, "separate PDF window contact sheet");
evidence.push("Separate PDF reader windows display the contact sheet");
separate.close(); second.close();
window.Zotero_Tabs.select(reader.tabID);
const finalDoc = reader._iframeWindow.document.getElementById("zvp-contact-frame").contentDocument;
finalDoc.getElementById('zvp-contact-size').value = '200';
finalDoc.getElementById('zvp-contact-size').dispatchEvent(new finalDoc.defaultView.Event('input',{bubbles:true}));
finalDoc.getElementById('zvp-contact-scroll').scrollTop = 0;
return { passed: true, version: Zotero.version, pluginVersion: addon.version, evidence, initial, zoom: { smallColumns, largeColumns, largeWidth }, stressItemID: stressID, tabID: reader.tabID };
