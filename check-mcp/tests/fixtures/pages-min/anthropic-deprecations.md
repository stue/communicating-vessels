---
title: Model deprecations
description: A made-up page in the shape of platform.claude.com's, for tests/check-043.test.ts (its title is the real page's, 0.4.4 R6).
---

* **Retired:** The model is no longer available for use. Requests to retired models fail.

The dates on this page apply to Anthropic-operated platforms: the Claude API, [Claude Platform on AWS](https://platform.claude.com/docs/en/build-with-claude/claude-platform-on-aws), [Claude Models on Google Cloud (Anthropic managed)](https://platform.claude.com/docs/en/build-with-claude/claude-models-on-google-cloud/anthropic-managed), and [Microsoft Foundry](https://platform.claude.com/docs/en/build-with-claude/claude-in-microsoft-foundry). Partner-operated platforms, Claude Models on Google Cloud (Google managed) and Amazon Bedrock, set their own retirement schedules, so a model’s lifecycle status and dates can differ.

## Notifications

Anthropic notifies customers with active deployments for models with upcoming retirements, providing at least 60 days’ notice before model retirement for publicly released models.

## Model status

| API model name    | Current state | Deprecated   | Tentative retirement date      |
| :---------------- | :------------ | :----------- | :----------------------------- |
| claude-mini-1     | Retired       | May 1, 2026  | June 1, 2026                   |
| claude-mini-2     | Active        | N/A          | Not sooner than May 1, 2099    |

## Deprecation history

### 2026-05-01: Claude Mini 1 model

| Retirement date | Deprecated model  | Recommended replacement |
| --------------- | ----------------- | ----------------------- |
| June 1, 2026    | `claude-mini-1`   | `claude-mini-2`         |
