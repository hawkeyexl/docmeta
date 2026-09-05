---
title: Install the operator on Kubernetes
description: Deploy the operator with Helm and verify the rollout.
id: install-operator-k8s
type: how-to
keywords: [helm, operator]
language: en

authors: [Jane Doe]
owner: platform-docs
created: 2025-11-04
last-updated: 2026-08-20
stakeholders: [jane.doe, pm-alex]
reviewed-by: [sam.reviewer]
last-reviewed: 2026-08-20
review-interval: P90D
verified-against: operator 1.4.2
source-of-truth: https://github.com/example/operator/tree/main/helm
generated-by: claude-fable-5
provenance:
  - generated-by: claude-fable-5
    fields: [intent, sample-questions]
    confidence:
      intent: 0.9
      sample-questions: 0.84

audiences: [administrators]
personas: [persona-platform-admin]
journeys: [cuj-install]
intent: Deploy the operator on a running cluster
visibility: public

applies-to: [operator-1.3, operator-1.4, kubernetes]
not-applicable-to: [operator-1.4-fips]
concepts: [Operator, Helm chart, namespace]

lifecycle: published
risks: [privileged, cost-incurring]

prerequisites: [create-api-token]
next-steps: [verify-rollout]
related-pages: [operator-architecture]
sample-questions:
  - How do I install the operator on EKS?
  - Which Helm values enable the webhook?
---

# Install the operator
