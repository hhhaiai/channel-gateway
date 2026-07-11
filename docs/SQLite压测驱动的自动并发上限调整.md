# SQLite 压测驱动的自动并发上限调整

## 1. 调整结果

资源感知自动并发上限从 32 调整为 8：

```js
DELIVERY_CONCURRENCY_AUTO_MAX === 8
DELIVERY_CONCURRENCY_HARD_MAX === 256
```

这只影响没有显式配置、也没有环境变量覆盖的自动探测路径。

优先级保持：

```text
plugin config
> CHANNEL_GATEWAY_DELIVERY_MAX_CONCURRENCY
> CPU/内存自动探测（上限 8）
```

## 2. 调整依据

200 endpoints、3980 deliveries、Fake provider 1 ms 延迟的实测：

| 全局并发 | 耗时 | deliveries/s |
|---:|---:|---:|
| 1 | 731 ms | 5444 |
| 8 | 1158 ms | 3437 |
| 32 | 3479 ms | 1144 |

SQLite 是单写模型。高 lane 数增加 claim transaction、active destination/account exclusion 和 due-row 扫描成本。真实网络延迟会让并发更有价值，但仅根据高配机器 CPU/内存自动选择 32 已没有证据支持。

自动上限 8 是保守启动值，不是所有部署的理论最优值。

## 3. 保留的人工调整能力

管理员仍可通过配置：

```json
{ "deliveryMaxConcurrency": 32 }
```

或环境变量：

```bash
CHANNEL_GATEWAY_DELIVERY_MAX_CONCURRENCY=32
```

设置 `1..256`。适用于高延迟 provider、非 SQLite adapter 或已经完成目标环境压测的部署。

网页继续允许手工设置到 256，并新增显示：

```text
SQLite 自动上限 8
```

因此管理员能区分：

- 自动保守上限 8。
- 系统绝对配置硬上限 256。

## 4. 容器和宿主探测

自动公式仍然读取当前进程可见资源：

```text
min(CPU × 2, memory / 256 MiB, 8)
```

- Docker 中优先使用 `process.constrainedMemory()`。
- 普通电脑部署在没有约束时使用宿主内存。
- CPU 使用 `os.availableParallelism()`，能够反映多数容器 CPU 配额。

低资源环境仍可能得到 1、2 或 4，不会被强制提高到 8。

## 5. 未改变的边界

- 同 destination conversation 始终串行。
- 每账号并发默认 2，硬范围 `1..64`。
- Token Bucket 和 provider cooldown 不变。
- 显式并发硬范围 `1..256`。
- 保存网页配置后重启生效。
- 不依据 endpoint 数量自动无限增加 lane。

## 6. 测试覆盖

- 1 CPU / 256 MiB 自动为 1。
- 1 CPU / 512 MiB 自动为 2。
- 2 CPU / 4 GiB 自动为 4。
- 8 CPU 和 32 CPU 均受自动上限 8 约束。
- 配置和环境变量仍可覆盖为 12、16 等高于自动上限的值。
- 网页 API 同时返回自动上限 8 和硬上限 256。
