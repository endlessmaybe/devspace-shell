import { sendArchivedChatgptMessage, candidatePipes } from './adapters/desktop-pipe.mjs';
import { NewAppToolAdmission } from './adapters/new-app-tool-admission.mjs';
import { taskPrompt } from './prompts.mjs';

export class Controller {
  constructor({ store, config, url, send = sendArchivedChatgptMessage }) {
    this.store = store; this.config = config; this.url = url; this.send = send;
    this.admission = new NewAppToolAdmission(store.db); this.busy = false; this.nextAttempt = 0;
  }
  readiness() {
    return { mode: this.config.executor.mode, pluginPaired: Boolean(this.config.plugin?.pairedAt) && this.config.plugin.compatible !== false,
      pluginCompatibility: this.config.plugin?.compatibility || null,
      desktopBridgeAvailable: process.platform === 'win32' && candidatePipes().length > 0,
      modelLabel: this.config.modelLabel || null, modelVerified: false, admission: this.admission.status() };
  }
  async dispatch(id) {
    if (this.busy) throw new Error('派发正在进行，请稍后。');
    if (this.config.executor.mode !== 'desktop') throw new Error('当前为手动模式，请复制执行口令到已启用插件的 GPT。');
    if (!this.config.plugin?.pairedAt) throw new Error('请先完成 GPT 插件配对。');
    if (this.config.plugin.compatible === false) throw new Error('DevSpace 工具契约不兼容，请重新配对；未派发任务。');
    if (!this.config.executor.callerThreadId || !this.config.executor.destinationThreadId) throw new Error('请先填写桌面桥接聊天配置。');
    if (this.admission.status().blocked) throw new Error('客户端请求正在冷却，请等待提示的重试时间。');
    this.busy = true;
    let row;
    try {
      row = this.store.beginDispatch(id);
      const result = await this.admission.run('dispatch', () => this.send({
        callerThreadId: this.config.executor.callerThreadId, destinationThreadId: this.config.executor.destinationThreadId,
        prompt: taskPrompt(this.config, row, this.url()), callId: row.dispatch_id,
      }));
      if (result?.sent) return this.store.finishDispatch(id, 'sent');
      this.nextAttempt = Date.now() + 30_000;
      return this.store.finishDispatch(id, 'refused', '目标聊天仍在响应，请等待它空闲。');
    } catch (error) {
      this.nextAttempt = Date.now() + 30_000;
      if (row) this.store.finishDispatch(id, error.deliveryState === 'unknown' ? 'unknown' : 'refused', error.message);
      throw error;
    } finally { this.busy = false; }
  }
  async tick() {
    this.store.expire();
    if (!this.config.autoDispatch || this.config.executor.mode !== 'desktop' || !this.config.plugin?.pairedAt || this.config.plugin.compatible === false || this.busy || Date.now() < this.nextAttempt || this.admission.status().blocked) return;
    if (this.store.hasActiveTask()) return;
    const next = this.store.nextQueued();
    if (next) await this.dispatch(next.id).catch(() => {});
  }
}
