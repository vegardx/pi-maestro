# Terraform Module Patterns

Use this reference when Terraform work needs examples beyond the core
`SKILL.md` rules.

## Contents

- [Repository Shapes](#repository-shapes)
- [README Structure](#readme-structure)
- [terraform.tf](#terraformtf)
- [Thin Module](#thin-module)
- [Null Passthroughs](#null-passthroughs)
- [Cycle-Safe Composition](#cycle-safe-composition)
- [Optional Companion Resources](#optional-companion-resources)
- [Tests](#tests)

## Repository Shapes

Single-module repositories expose the root directory as the module:

```text
terraform-aws-thing/
  README.md
  terraform.tf
  main.tf
  variables.tf
  outputs.tf
  locals.tf
  tests/
    default.tftest.hcl
  examples/
    basic/
      terraform.tf
      main.tf
```

Meta-module repositories expose the root as the primary batteries-included module
and `modules/*` as lower-level escape hatches:

```text
terraform-aws-service/
  README.md
  terraform.tf
  main.tf
  variables.tf
  outputs.tf
  locals.tf

  modules/
    security-group/
      README.md
      terraform.tf
      main.tf
      variables.tf
      outputs.tf
      tests/
        default.tftest.hcl

    iam-role/
      README.md
      terraform.tf
      main.tf
      variables.tf
      outputs.tf
      tests/
        default.tftest.hcl

  tests/
    default.tftest.hcl

  examples/
    basic/
      terraform.tf
      main.tf
    custom-security-groups/
      terraform.tf
      main.tf
```

Consumers should usually use the root meta-module:

```hcl
module "service" {
  source = "github.com/org/terraform-aws-service?ref=v1.2.3"

  name_prefix          = "my-app-"
  permissions_boundary = var.permissions_boundary
}
```

Consumers may use submodules directly when the meta-module is too opinionated:

```hcl
module "service_role" {
  source = "github.com/org/terraform-aws-service//modules/iam-role?ref=v1.2.3"

  name_prefix          = "my-app-task-"
  assume_role_policy   = data.aws_iam_policy_document.task.json
  permissions_boundary = var.permissions_boundary
}
```

## README Structure

Every module README should have hand-written context before generated
`terraform-docs` output:

```markdown
# terraform-aws-service

Short statement of what this module creates.

## Usage

Minimal working example.

## Module Shape

Explain whether this is a single module, a root meta-module, or a lower-level
submodule. Link available submodules for meta-module repositories.

## Design Notes

Explain important conventions such as flat variables, `null` passthroughs,
`name_prefix`, permission boundary passthrough, and composition-layer
relationships.

## Examples

Link `examples/*`.

<!-- BEGIN_TF_DOCS -->
<!-- END_TF_DOCS -->
```

Use `terraform-docs` for generated Requirements, Providers, Modules, Resources,
Inputs, and Outputs sections. Do not hand-maintain those tables.

## terraform.tf

Use `terraform.tf` for required versions, provider requirements, and minimal
backend declarations:

```hcl
terraform {
  required_version = ">= 1.6, < 2.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 5.0"
    }
  }

  backend "s3" {}
}
```

For AWS, keep concrete backend values in CI:

```bash
terraform init \
  -backend-config="bucket=my-state-bucket" \
  -backend-config="key=prod/app/terraform.tfstate" \
  -backend-config="region=eu-west-1" \
  -backend-config="use_lockfile=true"
```

## Thin Module

Thin modules usually expose one primary resource named `this`.

```hcl
variable "name_prefix" {
  description = "Prefix used for named AWS resources."
  type        = string
  nullable    = false
}

variable "permissions_boundary" {
  description = "ARN of the permissions boundary to attach to IAM principals. Null omits it."
  type        = string
  default     = null
}

resource "aws_iam_role" "this" {
  name_prefix          = var.name_prefix
  assume_role_policy   = var.assume_role_policy
  permissions_boundary = var.permissions_boundary
}

output "role" {
  description = "The IAM role resource."
  value       = aws_iam_role.this
}
```

## Null Passthroughs

Use `null` to mean unset/provider default when the provider supports it.

Good:

```hcl
variable "force_destroy" {
  description = "Whether to allow Terraform to delete a non-empty bucket. Null lets AWS/provider defaults apply."
  type        = bool
  default     = null
}

resource "aws_s3_bucket" "this" {
  bucket_prefix = var.name_prefix
  force_destroy = var.force_destroy
}
```

Bad:

```hcl
resource "aws_s3_bucket" "this" {
  bucket_prefix = var.name_prefix
  force_destroy = var.force_destroy == "" ? null : var.force_destroy
}
```

## Cycle-Safe Composition

Define relationship resources in the parent/root/meta-module when two modules
need to reference each other. This keeps child modules lifecycle-independent and
helps avoid dependency cycles or destroy-order failures.

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

resource "aws_vpc_security_group_egress_rule" "app_to_db" {
  security_group_id            = module.app_sg.security_group.id
  referenced_security_group_id = module.db_sg.security_group.id
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

The same rule applies to any resources whose mutual references can couple module
lifecycles, not only security groups.

## Optional Companion Resources

Prefer splitting optional companion resources into separate thin modules or
owning them in the meta-module. Use `count` or `for_each` conditionals only when
Terraform/provider modeling makes separation awkward.

## Tests

Reusable modules should include `.tftest.hcl` tests for important defaults,
outputs, and composition behavior.

```hcl
run "default" {
  command = plan

  assert {
    condition     = aws_iam_role.this.name_prefix == var.name_prefix
    error_message = "role name_prefix must come from var.name_prefix"
  }
}
```
