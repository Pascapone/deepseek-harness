---
kind: upgrade-guide
description: Broad workspace glob scans include ignored files unless deployments explicitly select the respect policy.
---

# Broad glob ignore policy

English | [中文](guide.zh.md)

## Change

`@deepseek-ai/dsh-tool-fs-search` no longer hardcodes the deployment-specific ignore policy for unfiltered workspace-root discovery. By default, `glob` includes ignored files for every pattern while retaining hidden-file support and VCS metadata exclusions. The tool description reflects the resolved configuration.

## Migration

1. To preserve the previous broad-scan behavior, set `globRootIgnorePolicy: respect` in each search-tool row's existing `config`. Preserve `sampleOverCapGlobResults` and all other configured values.
2. Apply the choice separately to preset-owned search rows: a root row's configuration does not override a preset's own row. The candidate Ponytail bundle and preserved preset settings explicitly select `respect`.
3. Confirm that `*` and `**/*`, with no path or `path: .`, honor ignore files under `respect`. More specific patterns and explicit subtrees still include ignored files. Choose `include`, or remove the option, to restore native discovery. Removing a bundle's configuration contribution differs from unloading its prompt plugin; an explicitly configured search-tool row keeps its policy until its configuration changes.
