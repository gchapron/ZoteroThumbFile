"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const source = fs.readFileSync(path.join(__dirname, "..", "bootstrap.js"), "utf8");
function setup() {
  let errors = [], listeners = [{ pluginID: "other-plugin" }];
  let context = vm.createContext({
    setTimeout, clearTimeout,
    Zotero: {
      initializationPromise: Promise.resolve(), getMainWindows: () => [], logError: e => errors.push(e),
      Reader: {
        _readers: [], registerEventListener: (type, handler, pluginID) => listeners.push({ type, handler, pluginID }),
        _unregisterEventListenerByPluginID: id => { listeners = listeners.filter(x => x.pluginID !== id); }
      }
    },
    Services: { prefs: { getBoolPref: (_key, fallback) => fallback, getIntPref: (_key, fallback) => fallback, setIntPref() {} } },
    Components: { utils: { cloneInto: x => x, waiveXrays: x => x } }
  });
  vm.runInContext(source, context);
  return { plugin: context.PageThumbnails, layout: context.ContactSheetLayout, context, errors, listeners: () => listeners };
}
const flush = () => new Promise(resolve => setImmediate(resolve));
function node() { return { style: {}, setAttribute() {}, classList: { toggle() {} }, remove() { this.removed = true; } }; }

test("virtualization reaches the final page of long PDFs at every supported zoom", () => {
  const { layout } = setup();
  for (let count of [1, 80, 10000]) for (let size of [100, 200, 400]) for (let width of [300, 1000, 1800]) {
    let first = layout.calculate({ count, size, width, height: 700, scrollTop: 0 });
    assert.equal(first.start, 0);
    assert.ok(first.end <= count);
    let last = layout.calculate({ count, size, width, height: 700, scrollTop: Math.max(0, first.totalHeight - 700) });
    assert.equal(last.end, count);
    assert.ok(last.start <= count - 1);
    assert.ok(last.end - last.start < 150, "DOM rows stay bounded even for 10,000 pages");
  }
});

test("zoom clamps safely and changes columns and scroll height", () => {
  const { layout } = setup();
  assert.equal(layout.size(-20), 100); assert.equal(layout.size(5000), 400); assert.equal(layout.size(NaN), 200);
  let small = layout.calculate({ count: 80, size: 100, width: 1440, height: 700, scrollTop: 0 });
  let large = layout.calculate({ count: 80, size: 400, width: 1440, height: 700, scrollTop: 0 });
  assert.ok(small.columns > large.columns);
  assert.ok(large.totalHeight > small.totalHeight);
});

test("startup adds a synchronous PDF toolbar hook and cleanup preserves other plugins", async () => {
  let h = setup(); await h.context.startup();
  let calls = [];
  h.plugin.ensureReader = () => ({ button: "button" });
  h.plugin.initializeReader = () => calls.push("init");
  let hook = h.listeners().find(x => x.pluginID === h.plugin.id).handler;
  hook({ reader: { type: "epub" }, append: () => calls.push("incorrect") });
  hook({ reader: { type: "pdf" }, append: button => calls.push(button) });
  assert.deepEqual(calls, ["button", "init"]);
  h.context.shutdown();
  assert.equal(h.listeners().length, 1); assert.equal(h.listeners()[0].pluginID, "other-plugin");
});

test("same-key cancelled render is replaced during rapid close/reopen", () => {
  let { plugin } = setup();
  plugin.pump = () => {};
  let cell = { node: node(), image: node(), key: "0:200" };
  let cancelled = { key: "0:200", generation: 0, cancelled: true };
  let record = {
    visible: true, ready: true, count: 1, size: 200, generation: 1,
    scroll: { clientWidth: 500, clientHeight: 700, scrollTop: 0 }, grid: node(),
    doc: { defaultView: { devicePixelRatio: 1 } }, cells: new Map([[0, cell]]),
    cache: new Map(), failed: new Set(), tasks: new Set([cancelled]), queue: []
  };
  plugin.layout(record);
  assert.equal(record.queue.length, 1);
  assert.equal(record.queue[0].key, cancelled.key);
});

test("render queue limits concurrency, discards stale results and cancels active canvases", async () => {
  let { plugin } = setup(); let started = [], cancelled = 0;
  plugin.renderPage = async (_record, task) => {
    task.renderTask = { cancel: () => cancelled++ };
    return new Promise(resolve => started.push({ task, resolve }));
  };
  let record = { visible: true, generation: 0, tasks: new Set(), queue: [0,1,2].map(index => ({ index, key: String(index) })), cache: new Map(), cells: new Map() };
  plugin.pump(record);
  assert.equal(started.length, 2); assert.equal(record.tasks.size, 2);
  plugin.cancelRendering(record);
  assert.equal(cancelled, 2); assert.equal(record.queue.length, 0);
  for (let item of started) item.resolve("stale-image");
  await flush();
  assert.equal(record.cache.size, 0); assert.equal(record.tasks.size, 0);
});

test("cache has a byte budget as well as an image-count budget", async () => {
  let { plugin } = setup();
  plugin.renderPage = async () => "x".repeat(8 * 1024 * 1024);
  let record = { visible: true, generation: 0, tasks: new Set(), queue: [0,1,2].map(index => ({ index, key: String(index) })), cache: new Map(), cells: new Map() };
  plugin.pump(record); await flush(); await flush();
  let bytes = [...record.cache.values()].reduce((sum,x)=>sum+x.length*2,0);
  assert.ok(bytes <= 24*1024*1024); assert.equal(record.cache.size, 1);
});

test("contact sheet visibility does not call or alter native sidebar APIs", () => {
  let { plugin } = setup(); plugin.layout = () => {};
  let state = { sidebarOpen: true, sidebarView: "annotations", primaryViewStats: { pageIndex: 3 } };
  let record = { button: node(), frame: node(), overlay: node(), scroll: { focus() {} }, reader: { _internalReader: { _state: state }, focus() {} }, tasks: new Set(), queue: [], generation: 0 };
  plugin.setVisible(record, true);
  assert.equal(record.selected, 3); assert.equal(record.frame.hidden, false);
  plugin.setVisible(record, false);
  assert.equal(record.frame.hidden, true);
  assert.equal(state.sidebarOpen, true); assert.equal(state.sidebarView, "annotations");
});

test("early keyboard events before PDF readiness are safe", () => {
  let { plugin } = setup();
  for (let key of ["ArrowDown", "Home", "End", "Enter"]) {
    assert.doesNotThrow(() => plugin.handleKey({ ready: false }, { key, target: {}, preventDefault() {} }));
  }
});

test("zoom preview replacement waits for decode and never clears the existing image", async () => {
  let { plugin } = setup(), decode;
  let oldImage = { old: true }, replacement = { decode: () => new Promise(resolve => { decode = resolve; }) };
  let image = { children: [oldImage], replaceChildren(next) { this.children = [next]; } };
  let cell = { key: "0:800", displayedKey: "0:400", pendingImageKey: null, image };
  let record = { doc: { createElement: () => replacement }, cache: new Map() };
  plugin.putImage(record,cell,"0:800","new-raster");
  assert.equal(image.children[0],oldImage,"Old preview survives until replacement finishes decoding");
  decode(); await flush();
  assert.equal(image.children[0],replacement);
  assert.equal(cell.displayedKey,"0:800");
});

test("outdated decoded zoom results cannot replace the latest requested preview", async () => {
  let { plugin } = setup(), decode;
  let oldImage = {}, image = { children: [oldImage], replaceChildren(next) { this.children = [next]; } };
  let cell = { key:"0:600",displayedKey:"0:400",pendingImageKey:null,image };
  let record = { doc:{createElement:()=>({decode:()=>new Promise(resolve=>{decode=resolve;})})},cache:new Map() };
  plugin.putImage(record,cell,"0:600","stale");
  cell.key="0:800"; cell.pendingImageKey=null;
  decode(); await flush();
  assert.equal(image.children[0],oldImage);
});

test("rendering pauses while a zoom gesture is changing the grid", () => {
  let {plugin}=setup(),started=0;
  plugin.renderPage=async()=>{started++;return "image";};
  let record={visible:true,zooming:true,tasks:new Set(),queue:[{key:"0:800",index:0}]};
  plugin.pump(record);
  assert.equal(started,0); assert.equal(record.queue.length,1);
});

test("failed higher-resolution rendering keeps the previous visible preview", async () => {
  let {plugin}=setup();plugin.renderPage=async()=>{throw new Error("PDF render failed");};
  let image={textContent:"unchanged"},cell={key:"0:800",displayedKey:"0:400",image};
  let record={visible:true,generation:0,tasks:new Set(),queue:[{key:"0:800",index:0}],cache:new Map(),failed:new Set(),cells:new Map([[0,cell]])};
  plugin.pump(record);await flush();
  assert.equal(image.textContent,"unchanged"); assert.ok(record.failed.has("0:800"));
});

test("continuous zoom preserves fractional geometry while rounding only saved preference", () => {
  let {plugin,layout,context}=setup(),saved;
  context.Services.prefs.setIntPref=(_key,value)=>{assert.ok(Number.isInteger(value));saved=value;};
  plugin.cancelRendering=()=>{};plugin.scheduleLayout=()=>{};
  let record={sizeLabel:{},slider:{},scroll:{scrollTop:0},layout:null};
  plugin.resize(record,"237.25");
  assert.equal(record.size,237.25);
  assert.equal(record.slider.value,"237.25");
  assert.equal(record.sizeLabel.textContent,"237 px");
  assert.equal(saved,237);
  let geometry=layout.calculate({count:80,size:record.size,width:1440,height:700,scrollTop:0});
  assert.equal(geometry.cellWidth,269.25);
  clearTimeout(record.zoomTimer);
});
