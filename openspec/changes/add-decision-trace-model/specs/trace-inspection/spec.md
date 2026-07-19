# trace-inspection Delta

## ADDED Requirements

### Requirement: Hierarchical step view

The system SHALL render the step hierarchy via `agent-replay show <trace-id> --tree`, nesting child steps under their `parent_step` and marking causal links, falling back to the flat timeline when no structure is present.

#### Scenario: Tree rendering

- **WHEN** a user runs `show <id> --tree` on a trace where steps 4–6 are children of step 3
- **THEN** steps 4–6 render indented beneath step 3

#### Scenario: Flat trace fallback

- **WHEN** a user runs `show <id> --tree` on a trace with no parent references
- **THEN** the ordinary flat timeline is shown without error
