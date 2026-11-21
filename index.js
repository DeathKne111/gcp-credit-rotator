import { LOG_PREFIX, SINGLETON_KEY, VERSION } from './src/constants.js';
import { createLogger } from './src/log.js';
import { createRotator } from './src/rotator.js';
import { mountPanel } from './src/panel.js';
import { installRequestGuard } from './src/request-guard.js';

/**
 * 入口。
 *
 * 只做四件事：
 *   1) 等宿主扩展设置容器就绪
 *   2) 建轮换器 + 挂面板
 *   3) 安装 fetch 请求守卫（仅 Vertex 生成请求的 429/402 换号补发）
 *   4) 订阅 GENERATION_STARTED / GENERATION_ENDED 驱动「每条回复后轮换」
 *
 * 不修改任何 API 接入设置：不写 vertexai_region / vertexai_model /
 * vertexai_auth_mode / 连接字段，只切 secrets 里哪一条服务账号是 active。
 */

const MOUNT_SELECTORS = ['#extensions_settings2', '#extensions_settings'];
const WAIT_TIMEOUT_MS = 30000;
const WAIT_INTERVAL_MS = 200;

function waitFor(check, timeout = WAIT_TIMEOUT_MS, interval = WAIT_INTERVAL_MS) {
    return new Promise(resolve => {
        const startedAt = Date.now();
        const tick = () => {
            let value = null;
            try {
                value = check();
            } catch {
                value = null;
            }
            if (value) {
                resolve(value);
                return;
            }
            if (Date.now() - startedAt >= timeout) {
                resolve(null);
                return;
            }
            setTimeout(tick, interval);
        };
        tick();
    });
}

function findMountPoint() {
    for (const selector of MOUNT_SELECTORS) {
        const node = document.querySelector(selector);
        if (node) return node;
    }
    return null;
}

async function boot() {
    const existing = globalThis[SINGLETON_KEY];
    if (existing?.promise) return existing.promise;

    const state = {
        promise: null,
        rotator: null,
        panel: null,
        uninstallGuard: null,
        log: null,
        version: VERSION,
    };
    globalThis[SINGLETON_KEY] = state;

    state.promise = (async () => {
        const mount = await waitFor(findMountPoint);
        if (!mount) throw new Error('等待 #extensions_settings 超时');

        const context = globalThis.SillyTavern?.getContext?.();
        if (!context) throw new Error('SillyTavern.getContext() 不可用');

        const log = createLogger();
        state.log = log;

        const rotator = createRotator({ context, log });
        state.rotator = rotator;

        state.panel = mountPanel({ rotator, log, getGuard: () => state.uninstallGuard });

        // 延迟安装请求守卫：页面里其它扩展（实测托梦）会在启动早期包装 fetch，
        // 我们先装会被它用自己保存的旧 fetch 顶掉。等它就位后再装，我们就在它外层。
        // 安装时绝不改动别人的 original，否则会形成调用环（实测爆栈两次）。
        const installGuard = () => {
            if (state.uninstallGuard) return;
            const detach = installRequestGuard({ rotator, log });
            state.uninstallGuard = detach;
            if (detach.isInChain?.()) {
                log.info('429 兜底已接入请求链');
            } else {
                log.warn('429 兜底未接入（fetch 由其它扩展占用），仅执行凭据轮换');
            }
            state.panel?.render?.(rotator.snapshot());
        };
        setTimeout(installGuard, 2000);
        setTimeout(installGuard, 6000);

        const eventTypes = context.eventTypes ?? {};
        const eventSource = context.eventSource;

        /** 总开关打开且当前是 Vertex 才工作，其它情况一律静默 */
        const syncWithSource = (announce = false) => {
            const active = rotator.isActive();
            if (active) {
                void rotator.refresh();
            }
            state.panel?.render?.(rotator.snapshot());
            if (announce) {
                const vertex = rotator.isVertexActive();
                if (active) log.info('已启用（Vertex 渠道）');
                else if (!vertex) log.info('当前不是 Vertex 渠道，插件静默');
                else log.info('总开关处于关闭状态，插件待命');
            }
            return active;
        };

        if (eventSource?.on && eventTypes.GENERATION_STARTED && eventTypes.GENERATION_ENDED) {
            eventSource.on(eventTypes.GENERATION_STARTED, () => rotator.onGenerationStarted());
            eventSource.on(eventTypes.GENERATION_ENDED, () => {
                void rotator.onGenerationEnded();
            });
        } else {
            log.warn('缺少生成事件，轮换退化为仅手动切换');
        }

        if (eventSource?.on && eventTypes.CHATCOMPLETION_SOURCE_CHANGED) {
            eventSource.on(eventTypes.CHATCOMPLETION_SOURCE_CHANGED, () => syncWithSource(true));
        }

        // 默认关闭：没打开总开关或不是 Vertex 时，一次 secrets 都不读
        if (rotator.isActive()) {
            await rotator.refresh();
            log.info('已启用（Vertex 渠道）');
        } else {
            syncWithSource(false);
            log.info(rotator.isVertexActive() ? '已待命（总开关关闭）' : '已待命（当前不是 Vertex 渠道）');
        }
        return state;
    })().catch(error => {
        const message = error instanceof Error ? error.message : String(error);
        try {
            (state.log ?? createLogger()).error(`初始化失败：${message}`);
        } catch {
            /* ignore */
        }
        console.error(`${LOG_PREFIX} 初始化失败`, error);
        return state;
    });

    return state.promise;
}

/** 宿主 hooks.activate 会调用这个导出 */
export function init() {
    return boot();
}

// 宿主以 ESM 方式 import 本文件时，顶层也会执行；单例保护保证只初始化一次。
if (!globalThis[SINGLETON_KEY]?.promise) {
    void boot();
}
