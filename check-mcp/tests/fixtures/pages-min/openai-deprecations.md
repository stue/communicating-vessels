# Deprecations

> A made-up page in the shape of developers.openai.com's, for tests/check-043.test.ts (its title is the real page's, 0.4.4 R6).

**Shutdown.** The model no longer accepts requests through the standard API.

## Upcoming deprecations

| Shutdown date    | Affected model | Status     | Recommended replacement | Notice date  |
| ---------------- | -------------- | ---------- | ----------------------- | ------------ |
| **Jan 14, 2099** | `gpt-mini-a`   | Deprecated | `gpt-mini-b`            | Oct 14, 2026 |
| **Jan 14, 2099** | GPT-4o (`gpt-4o-2099-01-01`) | Deprecated | `gpt-mini-b` | Oct 14, 2026 |
| **Jan 14, 2099** | GPT-4o mini (`gpt-4o-mini-2099-01-01`) | Deprecated | `gpt-mini-b` | Oct 14, 2026 |

Fine-tuned versions of the models listed above follow the same shutdown schedule as their underlying base models.

## Update to OpenAI’s self-serve fine-tuning

You can continue to run inference on each existing fine-tuned model until OpenAI retires its underlying base model.

## Past deprecations

| Shutdown date | Affected model or feature | Listed replacement | Notice date  |
| ------------- | ------------------------- | ------------------ | ------------ |
| **Oct 23, 2026** | `gpt-tied-a`, `gpt-tied-b` | `gpt-mini-b`    | Apr 22, 2026 |
| **Oct 1, 2026**  | `gpt-month-only`          | `gpt-mini-b`       | Sep 11, 2026 |
| Jan 1, 2025   | `gpt-old-a`               | `gpt-mini-b`       | Jan 1, 2024  |

### Historical notes

- Fine-tuned versions of the [legacy GPT models shut down in October 2026](https://developers.openai.com/api/docs/deprecations#2026-04-22-legacy-gpt-model-snapshots) followed the same shutdown schedule as their underlying base models.
- The October 2024 shutdown for [fine-tuning training on `babbage-002` and `davinci-002`](https://developers.openai.com/api/docs/deprecations#2024-08-29-fine-tuning-training-on-babbage-002-and-davinci-002-models) applied to creating new fine-tuned models. Existing fine-tuned models were unaffected by that change.
- Existing fine-tuned models from those GPT-3.5 Turbo snapshots were unaffected by that shutdown.
- The [legacy fine-tunes endpoint shutdown](https://developers.openai.com/api/docs/deprecations#2023-08-22-fine-tunes-endpoint) also removed access to models trained with that endpoint.
