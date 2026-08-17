---
name: terraform-style
description: >
  Use when writing, editing, reviewing, or scaffolding Terraform (.tf, .tfvars)
  or HCL files, including modules, providers, variables, outputs, backends, AWS
  infrastructure, IAM, state config, tests, README docs, and CI-driven plan/apply
  automation. Covers composable module layout, meta-modules, naming, flat
  variables, null passthroughs, outputs, backend conventions, AWS S3 locking,
  permission boundaries, cycle-safe composition, terraform-docs, and tooling.
  Do not use for non-Terraform IaC such as Pulumi, CloudFormation, CDK, or Ansible.
license: MIT
---

# Terraform Style

Apply these conventions when changing Terraform or HCL. Prefer the repository's
existing patterns when they are clear; otherwise use these defaults.

For fuller examples, read [references/module-patterns.md](references/module-patterns.md).

## Structure

- Use `terraform.tf` for `terraform {}` blocks, required Terraform versions,
  required providers, and minimal backend declarations.
- Use `main.tf`, `variables.tf`, and `outputs.tf` for implementation.
- Add `locals.tf` or purpose-specific files only when they improve scanability.
- Run `terraform fmt` on every changed module.

## Modules

- Prefer small composable modules.
- Use meta-modules to compose small modules into batteries-included units.
- Thin modules usually create one primary resource named `this`.
- If a thin module needs several primary resources, consider splitting it or
  moving composition into a meta-module.
- Keep provider configuration in root modules.
- Child modules declare provider requirements but do not configure providers.

> NOTE: Prefer explicit composition over generic modules with many feature flags.

## Module Repositories

- A module repo may be a single root module or a root meta-module with `modules/*`
  submodules.
- In meta-module repos, the root module is the primary supported interface.
- Submodules are supported escape hatches and must have their own README, tests,
  inputs, and outputs.
- Root README files must explain whether the repo is a single module or a
  meta-module, and link available submodules.

## Variables

- Prefer flat variables over large nested object inputs.
- Give every variable a `description` and `type`.
- Drive resource attributes from variables with sane defaults where possible.
- Use `null` as the default for optional provider-supported attributes.
- Pass `null` directly through to resources; avoid empty-string/list/map checks.
- Use `nullable = false` for required values that must not accept explicit null.
- Do not set `nullable = false` globally.

Good:

```hcl
variable "permissions_boundary" {
  description = "ARN of the permissions boundary to attach to IAM principals. Null omits it."
  type        = string
  default     = null
}
```

Bad:

```hcl
permissions_boundary = var.permissions_boundary == "" ? null : var.permissions_boundary
```

## Naming

- Use `snake_case` for Terraform identifiers.
- Use `resource "<type>" "this"` inside thin modules.
- Use role-specific names in root/meta-modules when composing multiple instances.
- For AWS resources, prefer `name_prefix` or `*_prefix` where supported.

## AWS

- Expose `permissions_boundary` on every module/resource that supports it.
- Default `permissions_boundary` to `null` and pass it through directly.
- Prefer standalone security group rule resources for relationships between
  security groups.
- Put cross-module security group rules in the parent/root/meta-module, not
  inside either security group module, because mutual rules can create dependency
  cycles and destroy-order problems.

## Composition

- Modules should not directly cross-reference sibling modules.
- Parent/root/meta-modules own relationships between modules.
- Keep bidirectional or cyclic relationships out of child modules.
- Define relationship resources at the composition layer when two resources need
  to reference each other.
- Do this to keep Terraform's dependency graph acyclic and avoid create/destroy
  loops that can make replacement or teardown fail.
- Output resource objects or IDs upward, then wire relationships at the
  composition layer.

Good:

```hcl
module "app_sg" {
  source = "./modules/security-group"

  name_prefix = "${var.name_prefix}-app-"
  vpc_id      = var.vpc_id
}

module "db_sg" {
  source = "./modules/security-group"

  name_prefix = "${var.name_prefix}-db-"
  vpc_id      = var.vpc_id
}

resource "aws_vpc_security_group_ingress_rule" "db_from_app" {
  security_group_id            = module.db_sg.security_group.id
  referenced_security_group_id = module.app_sg.security_group.id
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
}
```

Bad:

```hcl
module "app_sg" {
  source = "./modules/security-group"

  peer_security_group_id = module.db_sg.security_group.id
}

module "db_sg" {
  source = "./modules/security-group"

  peer_security_group_id = module.app_sg.security_group.id
}
```

## Outputs

- Output managed resource objects from modules.
- Output enough for parent/meta-modules to compose resources without guessing.
- Avoid exposing sensitive data; mark sensitive outputs with `sensitive = true`.

Good:

```hcl
output "role" {
  description = "The IAM role resource."
  value       = aws_iam_role.this
}
```

## Backend And State

- Keep backend blocks minimal in Terraform code.
- Provide concrete backend config from CI/CD, wrapper scripts, or
  `terraform init -backend-config=...`.
- For AWS, declare `backend "s3" {}` in code and provide bucket, key, region, and
  `use_lockfile = true` from CI.
- Do not use DynamoDB locking for new AWS backends.
- Treat state and plan files as sensitive.

## Versions

- Declare the required Terraform version.
- For shared child modules, use relaxed provider constraints for trusted providers
  such as AWS, usually `>=`.
- For root modules, use tighter constraints such as `~>` or rely on the lock file
  according to the repo's existing convention.

## README Docs

- Use `terraform-docs` by default for generated module reference docs.
- Keep hand-written README sections above generated docs.
- Include usage, module shape, design notes, examples, and submodule links.
- Do not hand-maintain generated Requirements, Providers, Modules, Resources,
  Inputs, or Outputs tables.
- Use `<!-- BEGIN_TF_DOCS -->` and `<!-- END_TF_DOCS -->` markers.
- Prefer a repo-level `.terraform-docs.yml`.

## Tooling And Tests

- Look for existing `tflint`, `terraform-docs`, security scanner, and pre-commit
  configuration before changing style.
- Run `terraform validate` and relevant scanner commands when available.
- Add `.tftest.hcl` tests for reusable modules by default.
- Test important inputs, defaults, outputs, and composition behavior.
