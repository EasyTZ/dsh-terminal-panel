// 客户端半的冒烟测试：在 node 里伪造 window / React，真跑一遍 factory、apply()
// 与两个槽组件的渲染路径，再把渲染出来的每个事件处理器都触发一次。
//
// 为什么非要有它：client.js 不进任何 typecheck，`node --check` 又只查语法。而
// 这个文件里有两类错误静态检查一概看不见：
//
//   1. **组件函数体里的自由变量** —— 引用一个不存在的标识符（漏在形参列表外的
//      prop、拼错的名字、忘了声明的 useState），语法完全合法，要到组件真正执行
//      时才抛。表现是「面板打不开」；
//   2. **事件处理器里的自由变量** —— 更隐蔽，因为处理器的函数体要到**触发时**才
//      求值。渲染一路绿灯，点下去才抛，而 React 会吃掉这次交互，受控组件弹回原
//      值。表现是「按钮点了没反应」，控制台之外毫无线索。
//
// 这不是假想的风险。同作者的插件市场（dsh-market）就是这么栽的：四个 bug 全是
// 这两类，纯逻辑单测 33 个全绿，面板却打不开、开关点不动。这里把那套做法搬过来。
//
// **两条从那次踩坑里换来的硬规矩**，改这个文件时别退回去：
//
//   · 下面那个迷你 React 必须是**真的会渲染**的（状态真存、effect 真跑、子组件真
//     调、setState 真触发重渲染）。写成「useState 原样返回初值 + useEffect 空函
//     数」的空壳版，面板会停在还没取到数据的早退分支上，真正复杂的那棵树一行都
//     不执行 —— 测试全绿而面板是坏的，比没有测试更糟。
//   · effect 的 teardown 不能在本轮就调。取数 effect 普遍用 `let alive = true` +
//     teardown 里置 false 来防竞态，立刻 teardown 等于让所有 `.then` 直接 return，
//     状态永远停在初始值。攒着，全部渲染完再一起清。
//
// 断言也要求「真的渲染到了」，而不只是「没抛异常」—— 早退分支同样不抛。

import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const CLIENT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "lib", "client.js");

/** 把伪造的 React 元素树拍平成数组，便于查找。 */
function flatten(node, out = []) {
	if (node === null || node === undefined || node === false) return out;
	if (Array.isArray(node)) {
		for (const child of node) flatten(child, out);
		return out;
	}
	if (typeof node !== "object") return out;
	out.push(node);
	const children = node.props && node.props.children;
	if (children !== undefined) flatten(children, out);
	return out;
}

/** 整棵树序列化成文本，用来断言「某个东西真的渲染出来了」。 */
function textOf(nodes) {
	return nodes.map((n) => JSON.stringify((n.props && n.props.children) ?? null) ?? "").join("\n");
}

/** 造一个够用的假事件。textarea 那几个处理器会读 currentTarget 上的选区。 */
function fakeEvent(over = {}) {
	const ta = { value: "np", selectionStart: 2, selectionEnd: 2, focus() {}, style: {}, scrollHeight: 20 };
	return {
		target: ta,
		currentTarget: ta,
		preventDefault() {},
		stopPropagation() {},
		key: "Escape",
		ctrlKey: false,
		shiftKey: false,
		clientX: 0,
		clientY: 0,
		...over
	};
}

/**
 * 把树里所有 `on*` 处理器都调一遍。
 *
 * 只要求「调得动、不抛」，不断言业务结果 —— 这里防的是上面第 2 类错误。
 * fetch / EventSource 都已经换成假的，触发到的请求落不到网络上。
 *
 * 注意它会把关闭按钮、最大化按钮之类也一并点了，面板状态之后就不可信。要断言
 * 「点完变成什么样」的用例得自己挑处理器，别接着这棵树往下写。
 */
function fireAll(nodes) {
	let fired = 0;
	for (const node of nodes) {
		for (const [key, value] of Object.entries(node.props || {})) {
			if (!/^on[A-Z]/.test(key) || typeof value !== "function") continue;
			value(fakeEvent());
			fired += 1;
		}
	}
	return fired;
}

// —— 假的服务端 ————————————————————————————————————————
// 按路由给**真实形状**的数据。给统一的空 `{}` 等于让会话列表永远是空的，标签、
// 输出区、输入框那几棵树一行都不执行 —— 和 effect 不跑是同一种自欺。
const SESSION = {
	id: "sess-1",
	token: "tok-1",
	workspaceId: "ws-1",
	cwd: "D:/work/demo",
	shellKind: "pwsh",
	state: "idle",
	currentCommand: null,
	lastExit: null
};

function fakeFetch(url) {
	const u = String(url);
	const body = () => {
		if (u.endsWith("/terminal/sessions")) return { ok: true, data: { sessions: [SESSION] } };
		if (u.endsWith("/terminal/session")) return { ok: true, data: { ...SESSION, id: "sess-2", token: "tok-2" } };
		if (u.endsWith("/terminal/complete")) {
			return { ok: true, data: { items: ["npm", "node"], start: 0, end: 2, insert: "npm", appendSpace: true, truncated: false } };
		}
		// exec / signal / clear / close / open-external 都只看 ok
		return { ok: true, data: {} };
	};
	return Promise.resolve({ ok: true, json: async () => body() });
}

function loadModule() {
	const src = fs.readFileSync(CLIENT, "utf8");
	const registrations = [];
	const styleTag = { dataset: {}, textContent: "", setAttribute() {} };
	const store = new Map();
	// document 级监听（Ctrl+C 兜底那条）攒起来，好在测试里单独触发。
	const docListeners = [];
	Object.assign(globalThis, {
		window: {
			__ModuleLoader__: { load(reg) { registrations.push(reg); } },
			// 有选中文本时不抢 Ctrl+C，这个分支要能求值。
			getSelection: () => ({ toString: () => "" })
		},
		document: {
			// 返回一个非 null 的容器：返回 null 会走 probeFooterContainer 里的告警
			// 分支，那条是给「上游改了类名」用的，不该在测试里天天喊。
			querySelector: () => ({}),
			createElement: () => styleTag,
			head: { appendChild() {} },
			body: { appendChild() {}, removeChild() {} },
			activeElement: null,
			addEventListener: (type, fn) => docListeners.push({ type, fn }),
			removeEventListener() {}
		},
		localStorage: {
			getItem: (k) => (store.has(k) ? store.get(k) : null),
			setItem: (k, v) => store.set(k, String(v)),
			removeItem: (k) => store.delete(k),
			key: (i) => [...store.keys()][i] ?? null,
			get length() { return store.size; }
		},
		// SSE：连上就不再有动静。这里不模拟推流 —— 那要连带模拟 rAF 合批和序号补
		// 齐，成本远高于它能多抓到的东西；流的正确性由 node 半的单测负责。
		EventSource: class {
			constructor(url) { this.url = url; this.readyState = 1; }
			addEventListener() {}
			close() {}
		},
		requestAnimationFrame: (fn) => setTimeout(fn, 0),
		cancelAnimationFrame: (id) => clearTimeout(id),
		fetch: fakeFetch
	});

	const reactJsx = {
		jsx: (type, props, key) => ({ type, props: props || {}, key }),
		jsxs: (type, props, key) => ({ type, props: props || {}, key }),
		Fragment: Symbol("Fragment")
	};

	// —— 一个够用的迷你 React ————————————————————————————
	// 见文件顶部那两条硬规矩：状态要真存、effect 要真跑、setState 要真触发重渲染。
	const cells = [];
	let cursor = 0;
	let dirty = false;
	const effects = [];
	const cell = (init) => {
		const i = cursor++;
		if (cells.length <= i) cells[i] = { v: typeof init === "function" ? init() : init };
		return cells[i];
	};
	const reactHooks = {
		useState(init) {
			const c = cell(init);
			return [c.v, (next) => {
				const value = typeof next === "function" ? next(c.v) : next;
				if (!Object.is(value, c.v)) { c.v = value; dirty = true; }
			}];
		},
		useReducer(reducer, init) {
			const c = cell(init);
			return [c.v, (action) => {
				const value = reducer(c.v, action);
				if (!Object.is(value, c.v)) { c.v = value; dirty = true; }
			}];
		},
		useRef(init) {
			const c = cell(() => ({ current: init }));
			return c.v;
		},
		useCallback: (fn) => fn,
		useMemo: (fn) => fn(),
		useEffect(fn, deps) { effects.push({ fn, deps }); },
		useSyncExternalStore: (_sub, get) => get()
	};

	// 真 React 会继续往下渲染子组件；jsx() 只造一个 `{type, props}` 描述对象，
	// 函数组件不会自己执行。面板内容全在子组件里，不往下走就只测了最外面那层壳。
	// **必须换成组件的输出**，而不是把输出塞回同一个节点的 children —— 后者 type
	// 还是那个函数，下一轮又命中这个分支，同一个组件被反复调用直到撞深度上限，
	// 真正的子树一个节点都不进最终的树（那样按钮全都不在，也就无从触发）。
	const deepRender = (node, depth = 0) => {
		if (node === null || node === undefined || typeof node !== "object" || depth > 60) return node;
		if (Array.isArray(node)) return node.map((child) => deepRender(child, depth + 1));
		if (typeof node.type === "function") return deepRender(node.type(node.props), depth + 1);
		const children = node.props && node.props.children;
		if (children === undefined) return node;
		return { ...node, props: { ...node.props, children: deepRender(children, depth + 1) } };
	};

	// 渲染到稳定：跑一遍组件（含子组件）→ 执行本轮攒下的 effect → 等一个宏任务
	//（fetch 是 async）→ 状态变了就再来一轮。上限 12 轮，防止写成死循环时测试挂住。
	reactHooks.__render = async (render) => {
		const teardowns = [];
		let last;
		for (let round = 0; round < 12; round += 1) {
			cursor = 0;
			dirty = false;
			effects.length = 0;
			last = deepRender(render());
			const seen = new Set();
			for (const { fn } of effects) {
				if (seen.has(fn)) continue;
				seen.add(fn);
				const teardown = fn();
				// teardown 攒着，理由见文件顶部第二条硬规矩。
				if (typeof teardown === "function") teardowns.push(teardown);
			}
			await new Promise((r) => setTimeout(r, 0));
			if (!dirty) break;
		}
		for (const fn of teardowns) fn();
		return last;
	};

	const fakeRequire = (id) => {
		if (id === "react/jsx-runtime") return reactJsx;
		if (id === "react") return reactHooks;
		throw new Error("unexpected require: " + id);
	};
	// eslint-disable-next-line no-eval
	eval(src);
	assert.strictEqual(registrations.length, 1, "应恰好注册一次");
	const mod = registrations[0].factory(fakeRequire);
	mod.__render = reactHooks.__render;
	mod.__docListeners = docListeners;
	return mod;
}

const cleanup = () => Object.assign(globalThis, {
	window: undefined,
	document: undefined,
	localStorage: undefined,
	fetch: undefined,
	EventSource: undefined,
	requestAnimationFrame: undefined,
	cancelAnimationFrame: undefined
});

/** 装好插件，拿到注册进两个槽的组件与它们的 inject 结果。 */
function mount() {
	const mod = loadModule();
	const captured = {};
	const injected = {};
	const opts = {};
	// 工作区 / 会话都是外部 store（useSyncExternalStore）。当前工作区的推导要靠
	// sessionIds 反查，所以这两份数据必须对得上，否则 linkedWorkspaceId 是 null，
	// 「新建标签」那条路就走不到。
	const workspaces = {
		list: {
			value: { items: [{ workspaceId: "ws-1", sessionIds: ["dsh-sess-1"] }], recentWorkspaceId: "ws-1" },
			subscribe() { assert.ok(this.value); return () => {}; },
			getSnapshot() { return this.value; }
		}
	};
	const sessions = {
		list: {
			value: { current: "dsh-sess-1" },
			subscribe() { assert.ok(this.value); return () => {}; },
			getSnapshot() { return this.value; }
		}
	};
	const ctx = {
		effect: (fn) => { fn(); return () => {}; },
		on: () => () => {},
		locale: { register() {} },
		theme: { getTheme: () => ({ active: { colorScheme: "dark" } }) },
		workspaces,
		sessions,
		slots: {
			inject: (key, cb) => { cb(); return () => {}; },
			register: (o, comp) => {
				captured[o.name + ":" + o.id] = comp;
				injected[o.id] = o.inject();
				opts[o.id] = o;
				return () => {};
			}
		}
	};
	mod.apply(ctx);
	return { mod, captured, injected, opts, t: (k) => k };
}

test("冒烟：打开的面板要真的渲染到有终端标签和输入框", async () => {
	try {
		const { mod, captured, injected, t } = mount();
		assert.strictEqual(typeof mod.apply, "function");
		assert.deepStrictEqual(mod.inject, ["slots", "locale", "workspaces", "sessions", "theme"]);

		const footer = captured["sidebar.footer.action:terminal-panel"];
		const panel = captured["shell.overlay:terminal-panel-overlay"];
		assert.ok(footer, "入口按钮应注册进 sidebar.footer.action");
		assert.ok(panel, "面板应注册进 shell.overlay");

		const footerProps = injected["terminal-panel"];
		const panelProps = injected["terminal-panel-overlay"];
		// 关着的时候也渲染一次：TerminalPanel 在挂载前返回 null，这条路径要能走通。
		panel({ t, ...panelProps });
		footer({ wide: true, t, ...footerProps });

		panelProps.store.toggle();
		const tree = flatten(await mod.__render(() => panel({ t, ...panelProps })));

		// **这两条是重点**：光「没抛异常」不够 —— 还没取到会话的早退分支也不抛。
		// 必须确认服务端那个会话真的变成了界面上的标签，输入框也真的渲染出来了。
		const text = textOf(tree);
		assert.ok(text.includes("D:/work/demo"), "状态栏应渲染出会话的 cwd");
		assert.ok(text.includes("pwsh"), "状态栏应渲染出 shell 类型");
		assert.ok(tree.some((n) => n.type === "textarea"), "应渲染出命令输入框");
	} finally {
		cleanup();
	}
});

test("渲染出来的每个事件处理器都要调得动（漏 prop 的只在触发时才抛）", async () => {
	try {
		const { mod, captured, injected, t } = mount();
		const panel = captured["shell.overlay:terminal-panel-overlay"];
		const panelProps = injected["terminal-panel-overlay"];
		panelProps.store.toggle();

		const fired = fireAll(flatten(await mod.__render(() => panel({ t, ...panelProps }))));
		assert.ok(fired > 5, `应触发到一批处理器，实际只有 ${fired} 个`);
	} finally {
		cleanup();
	}
});

test("输入框的键盘分支逐个走一遍（Enter / Tab / 上下翻历史 / Ctrl+C / Ctrl+L）", async () => {
	try {
		const { mod, captured, injected, t } = mount();
		const panel = captured["shell.overlay:terminal-panel-overlay"];
		const panelProps = injected["terminal-panel-overlay"];
		panelProps.store.toggle();

		const tree = flatten(await mod.__render(() => panel({ t, ...panelProps })));
		const ta = tree.find((n) => n.type === "textarea");
		assert.ok(ta && typeof ta.props.onKeyDown === "function", "输入框应有 onKeyDown");

		// 每个分支各自读 currentTarget 上不同的东西（选区位置、内容长度），一条条
		// 摆出来 —— fireAll 那种统一的假事件只会走进第一个匹配的分支。
		const cases = [
			{ name: "Tab 补全", ev: { key: "Tab" } },
			{ name: "Enter 执行", ev: { key: "Enter" } },
			{ name: "Shift+Enter 换行", ev: { key: "Enter", shiftKey: true } },
			{ name: "↑ 翻历史", ev: { key: "ArrowUp", currentTarget: { value: "np", selectionStart: 0, selectionEnd: 0, focus() {}, style: {} } } },
			{ name: "↓ 翻历史", ev: { key: "ArrowDown", currentTarget: { value: "np", selectionStart: 2, selectionEnd: 2, focus() {}, style: {} } } },
			{ name: "Ctrl+C 终止", ev: { key: "c", ctrlKey: true } },
			{ name: "Ctrl+C 有选中时让位复制", ev: { key: "c", ctrlKey: true, currentTarget: { value: "np", selectionStart: 0, selectionEnd: 2, focus() {}, style: {} } } },
			{ name: "Ctrl+L 清屏", ev: { key: "l", ctrlKey: true } },
			{ name: "普通字符", ev: { key: "a" } }
		];
		for (const { name, ev } of cases) {
			await assert.doesNotReject(async () => ta.props.onKeyDown(fakeEvent(ev)), `${name} 不该抛`);
		}
		// 输入变化那条另有一套（自适应高度会去读 style / scrollHeight）。
		ta.props.onChange(fakeEvent({ target: { value: "npm run build", style: {}, scrollHeight: 40, selectionStart: 12, selectionEnd: 12 } }));

		// document 级的 Ctrl+C 兜底监听：面板没聚焦时也要能终止，它不在树上，
		// fireAll 覆盖不到，只能从注册表里捞出来单独触发。
		for (const { type, fn } of mod.__docListeners) {
			if (type !== "keydown") continue;
			fn({ key: "c", ctrlKey: true, preventDefault() {}, target: {} });
		}
	} finally {
		cleanup();
	}
});

test("入口按钮排在 Git 之上（order 升序，数字小的在前）", () => {
	try {
		const { opts, captured, injected, t } = mount();
		const o = opts["terminal-panel"];
		assert.ok(o, "应注册 footer 入口");
		// 终端 90 / Git 100 / 市场 110。终端是最高频的入口，压在最上面。
		assert.strictEqual(o.order, 90);

		// 顺手把入口按钮点一下：它是唯一一个「面板还没挂载」时就存在的交互，
		// 坏了的话用户连面板都打不开，比面板内部任何一个按钮都致命。
		const footer = captured["sidebar.footer.action:terminal-panel"];
		const props = injected["terminal-panel"];
		const btn = flatten(footer({ wide: false, t, ...props })).find((n) => n.type === "button");
		assert.ok(btn && typeof btn.props.onClick === "function", "入口应是个可点的按钮");
		btn.props.onClick(fakeEvent());
		assert.strictEqual(props.store.getSnapshot(), true, "点一下应把面板打开");
	} finally {
		cleanup();
	}
});

test("徽标存储要记录会话 id，且错误优先", () => {
	try {
		const { injected } = mount();
		const badgeStore = injected["terminal-panel"].badgeStore;
		assert.ok(badgeStore, "应注入 badgeStore");
		badgeStore.set("success", "sess-1");
		assert.deepStrictEqual(badgeStore.getSnapshot(), { kind: "success", id: "sess-1" });
		badgeStore.set("error", "sess-2");
		assert.deepStrictEqual(badgeStore.getSnapshot(), { kind: "error", id: "sess-2" });
		// 错误优先：成功不能覆盖错误，这样打开面板时定位到最近失败的那个。
		badgeStore.set("success", "sess-3");
		assert.deepStrictEqual(badgeStore.getSnapshot(), { kind: "error", id: "sess-2" });
		badgeStore.clear();
		assert.strictEqual(badgeStore.getSnapshot(), null);
	} finally {
		cleanup();
	}
});


/**
 * 把源码里的注释行剔掉、反斜杠转义还原，再拿去匹配 CSS 规则。
 *
 * 这两步都不能省：这几个文件的注释里都写着 `[class*="footerActions"]` 这串选择器
 * （在解释它为什么长这样），只 grep 源码的话，把规则整条删掉、只留注释，测试照样
 * 绿。转义还原是因为规则可能写在双引号字符串里，文件里存的是 \" 而不是 "。
 */
function cssSource(file) {
	return fs.readFileSync(file, "utf8")
		.split("\n")
		.filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
		.join("\n")
		.replace(/\\"/g, '"');
}

test("侧边栏 footer 的纵向排列规则还在（别删，Git/市场/余额各有一份同样的）", () => {
	// 上游那个容器是 display:flex（默认 row、不换行）。这条规则最早只写在本插件里，
	// 结果「装了终端面板的机器一切正常、只装市场 + 余额的机器上三个图标挤成一行」
	// —— 一个插件的样式在替别的插件兜底，而任何一个插件都可能被单独安装。现在四个
	// footer 插件各带一份，重复是有意的，不是漏删。
	assert.ok(
		/\[class\*="footerActions"\]\{[^}]*flex-direction:column/.test(cssSource(CLIENT)),
		"终端面板必须自己注入 footerActions 的纵向排列规则"
	);
});

test("输出区的 warning 行样式应存在且使用黄色 token", () => {
	// stderr 不全是 error：npm / webpack / gcc / node 等工具的 warning 也走 stderr。
	// 若只有 dstLineErr 一种样式，warning 就会被整行涂红；这里要求渲染层同时提供
	// dstLineWarn，避免后续有人把“stderr = red”这条简化规则改回去时没测试拦住。
	assert.ok(
		/\.dstLineWarn\{[^}]*state-warn-primary[^}]*\}/.test(cssSource(CLIENT)),
		"终端面板必须注入使用 state-warn-primary 的 dstLineWarn 样式"
	);
});
