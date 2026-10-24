#!/usr/bin/env python3
"""Small, dependency-free coordination tool for Muse Agent Bridge.

The tool edits board/tasks.json and checks it against agents/registry.json.
It deliberately does not perform network or Git operations.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_BOARD = ROOT / "board" / "tasks.json"
DEFAULT_REGISTRY = ROOT / "agents" / "registry.json"

TASK_STATUSES = {
    "open",
    "in_progress",
    "handoff",
    "review",
    "blocked",
    "done",
    "cancelled",
}
AGENT_STATUSES = {"unclaimed", "active", "paused", "retired"}
TASK_ID_RE = re.compile(r"^task-(\d+)$")
AGENT_ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]*$")


def fail(message: str) -> None:
    print(f"error: {message}", file=sys.stderr)
    raise SystemExit(2)


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def load_json(path: Path, label: str) -> dict[str, Any]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        fail(f"{label} not found: {path}")
    except json.JSONDecodeError as exc:
        fail(f"{label} is not valid JSON ({path}): {exc}")
    if not isinstance(data, dict):
        fail(f"{label} must contain a JSON object: {path}")
    return data


def save_json(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(data, ensure_ascii=False, indent=2) + "\n"
    fd, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(payload)
        os.replace(temporary_name, path)
    except BaseException:
        try:
            os.unlink(temporary_name)
        except FileNotFoundError:
            pass
        raise


def agent_ids(registry: dict[str, Any]) -> set[str]:
    agents = registry.get("agents")
    if not isinstance(agents, list):
        return set()
    return {
        agent["id"]
        for agent in agents
        if isinstance(agent, dict) and isinstance(agent.get("id"), str)
    }


def validate_data(board: dict[str, Any], registry: dict[str, Any]) -> list[str]:
    errors: list[str] = []

    if board.get("version") != 1:
        errors.append("board version must be 1")
    if registry.get("version") != 1:
        errors.append("registry version must be 1")

    agents = registry.get("agents")
    if not isinstance(agents, list):
        errors.append("registry.agents must be a list")
        agents = []

    known_agents: set[str] = set()
    for index, agent in enumerate(agents):
        prefix = f"registry.agents[{index}]"
        if not isinstance(agent, dict):
            errors.append(f"{prefix} must be an object")
            continue
        agent_id = agent.get("id")
        if not isinstance(agent_id, str) or not AGENT_ID_RE.fullmatch(agent_id):
            errors.append(f"{prefix}.id must be a lowercase slug")
        elif agent_id in known_agents:
            errors.append(f"duplicate agent id: {agent_id}")
        else:
            known_agents.add(agent_id)
        for field in ("display_name", "owner"):
            if not isinstance(agent.get(field), str) or not agent[field].strip():
                errors.append(f"{prefix}.{field} must be a non-empty string")
        if agent.get("status") not in AGENT_STATUSES:
            errors.append(f"{prefix}.status is not a supported agent status")
        if not isinstance(agent.get("capabilities"), list) or not all(
            isinstance(item, str) for item in agent.get("capabilities", [])
        ):
            errors.append(f"{prefix}.capabilities must be a list of strings")

    tasks = board.get("tasks")
    if not isinstance(tasks, list):
        errors.append("board.tasks must be a list")
        return errors

    known_tasks: set[str] = set()
    for index, task in enumerate(tasks):
        prefix = f"board.tasks[{index}]"
        if not isinstance(task, dict):
            errors.append(f"{prefix} must be an object")
            continue

        task_id = task.get("id")
        if not isinstance(task_id, str) or not TASK_ID_RE.fullmatch(task_id):
            errors.append(f"{prefix}.id must look like task-001")
        elif task_id in known_tasks:
            errors.append(f"duplicate task id: {task_id}")
        else:
            known_tasks.add(task_id)

        for field in ("title", "description", "created_by", "created_at"):
            if not isinstance(task.get(field), str) or not task[field].strip():
                errors.append(f"{prefix}.{field} must be a non-empty string")

        created_by = task.get("created_by")
        if isinstance(created_by, str) and created_by not in known_agents:
            errors.append(f"{prefix}.created_by is not registered: {created_by}")

        status = task.get("status")
        if status not in TASK_STATUSES:
            errors.append(f"{prefix}.status is not a supported task status")

        owner = task.get("owner")
        if owner is not None and owner not in known_agents:
            errors.append(f"{prefix}.owner is not registered: {owner}")
        if status in {"in_progress", "handoff", "review"} and owner is None:
            errors.append(f"{prefix}.owner is required for status {status}")

        if not isinstance(task.get("history"), list):
            errors.append(f"{prefix}.history must be a list")
        else:
            for event_index, event in enumerate(task["history"]):
                event_prefix = f"{prefix}.history[{event_index}]"
                if not isinstance(event, dict):
                    errors.append(f"{event_prefix} must be an object")
                    continue
                for field in ("action", "actor", "at"):
                    if not isinstance(event.get(field), str) or not event[field].strip():
                        errors.append(f"{event_prefix}.{field} must be a non-empty string")
                actor = event.get("actor")
                if isinstance(actor, str) and actor not in known_agents:
                    errors.append(f"{event_prefix}.actor is not registered: {actor}")

        handoffs = task.get("handoffs", [])
        if not isinstance(handoffs, list):
            errors.append(f"{prefix}.handoffs must be a list")
        else:
            for handoff_index, handoff in enumerate(handoffs):
                handoff_prefix = f"{prefix}.handoffs[{handoff_index}]"
                if not isinstance(handoff, dict):
                    errors.append(f"{handoff_prefix} must be an object")
                    continue
                for field in ("from", "to"):
                    value = handoff.get(field)
                    if value not in known_agents:
                        errors.append(f"{handoff_prefix}.{field} is not registered: {value}")
                for field in ("at", "summary", "next_step"):
                    if not isinstance(handoff.get(field), str) or not handoff[field].strip():
                        errors.append(f"{handoff_prefix}.{field} must be a non-empty string")

    return errors


def load_and_validate(board_path: Path, registry_path: Path) -> tuple[dict[str, Any], dict[str, Any]]:
    board = load_json(board_path, "board")
    registry = load_json(registry_path, "registry")
    errors = validate_data(board, registry)
    if errors:
        for error in errors:
            print(f"error: {error}", file=sys.stderr)
        raise SystemExit(2)
    return board, registry


def find_task(board: dict[str, Any], task_id: str) -> dict[str, Any]:
    for task in board["tasks"]:
        if task["id"] == task_id:
            return task
    fail(f"task not found: {task_id}")
    raise AssertionError("unreachable")


def require_agent(registry: dict[str, Any], agent_id: str) -> None:
    if agent_id not in agent_ids(registry):
        fail(f"agent is not registered: {agent_id}")


def next_task_id(board: dict[str, Any]) -> str:
    highest = 0
    for task in board["tasks"]:
        match = TASK_ID_RE.fullmatch(task["id"])
        if match:
            highest = max(highest, int(match.group(1)))
    return f"task-{highest + 1:03d}"


def command_new_task(args: argparse.Namespace) -> int:
    board, registry = load_and_validate(args.board, args.registry)
    require_agent(registry, args.created_by)
    task_id = next_task_id(board)
    now = utc_now()
    task = {
        "id": task_id,
        "title": args.title,
        "description": args.description,
        "status": "open",
        "owner": None,
        "created_by": args.created_by,
        "created_at": now,
        "handoffs": [],
        "history": [
            {
                "action": "created",
                "actor": args.created_by,
                "at": now,
                "note": "Task created.",
            }
        ],
    }
    board["tasks"].append(task)
    errors = validate_data(board, registry)
    if errors:
        for error in errors:
            print(f"error: {error}", file=sys.stderr)
        return 2
    save_json(args.board, board)
    print(task_id)
    return 0


def command_claim(args: argparse.Namespace) -> int:
    board, registry = load_and_validate(args.board, args.registry)
    require_agent(registry, args.agent_id)
    task = find_task(board, args.task_id)

    if task["status"] == "open" and task.get("owner") is None:
        pass
    elif task["status"] == "handoff" and task.get("owner") == args.agent_id:
        pass
    elif task["status"] == "in_progress" and task.get("owner") == args.agent_id:
        fail(f"{args.task_id} is already claimed by {args.agent_id}")
    else:
        fail(
            f"{args.task_id} cannot be claimed by {args.agent_id}: "
            f"status={task['status']}, owner={task.get('owner')}"
        )

    now = utc_now()
    task["status"] = "in_progress"
    task["owner"] = args.agent_id
    task["claimed_at"] = now
    task["history"].append(
        {
            "action": "claimed",
            "actor": args.agent_id,
            "at": now,
            "note": f"Task claimed by {args.agent_id}.",
        }
    )
    save_json(args.board, board)
    print(f"claimed {args.task_id} by {args.agent_id}")
    return 0


def command_handoff(args: argparse.Namespace) -> int:
    board, registry = load_and_validate(args.board, args.registry)
    require_agent(registry, args.agent_id)
    require_agent(registry, args.to)
    if args.agent_id == args.to:
        fail("handoff sender and recipient must be different agents")
    task = find_task(board, args.task_id)
    if task.get("owner") != args.agent_id:
        fail(f"{args.task_id} is owned by {task.get('owner')}, not {args.agent_id}")
    if task["status"] not in {"in_progress", "review", "blocked"}:
        fail(f"{args.task_id} cannot be handed off from status {task['status']}")

    now = utc_now()
    handoff = {
        "at": now,
        "from": args.agent_id,
        "to": args.to,
        "summary": args.summary,
        "next_step": args.next_step,
    }
    task.setdefault("handoffs", []).append(handoff)
    task["status"] = "handoff"
    task["owner"] = args.to
    task["next_step"] = args.next_step
    task["history"].append(
        {
            "action": "handoff",
            "actor": args.agent_id,
            "at": now,
            "note": f"Handed off to {args.to}: {args.next_step}",
        }
    )
    save_json(args.board, board)
    print(f"handed off {args.task_id} from {args.agent_id} to {args.to}")
    return 0


def command_validate(args: argparse.Namespace) -> int:
    board = load_json(args.board, "board")
    registry = load_json(args.registry, "registry")
    errors = validate_data(board, registry)
    if errors:
        for error in errors:
            print(f"error: {error}", file=sys.stderr)
        return 2
    print(f"valid: {len(board['tasks'])} task(s), {len(registry['agents'])} agent(s)")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Coordinate agents through Muse Agent Bridge files.")
    parser.add_argument("--board", type=Path, default=DEFAULT_BOARD, help="path to board/tasks.json")
    parser.add_argument("--registry", type=Path, default=DEFAULT_REGISTRY, help="path to agents/registry.json")

    subparsers = parser.add_subparsers(dest="command", required=True)

    new_task = subparsers.add_parser("new-task", help="create an open task")
    new_task.add_argument("title")
    new_task.add_argument("--created-by", required=True)
    new_task.add_argument("--description", default="No description provided.")
    new_task.set_defaults(func=command_new_task)

    claim = subparsers.add_parser("claim", help="claim an open or handed-off task")
    claim.add_argument("task_id")
    claim.add_argument("agent_id")
    claim.set_defaults(func=command_claim)

    handoff = subparsers.add_parser("handoff", help="hand a task to another registered agent")
    handoff.add_argument("task_id")
    handoff.add_argument("agent_id")
    handoff.add_argument("--to", required=True)
    handoff.add_argument("--summary", required=True)
    handoff.add_argument("--next-step", required=True)
    handoff.set_defaults(func=command_handoff)

    validate = subparsers.add_parser("validate", help="validate board and registry JSON")
    validate.set_defaults(func=command_validate)

    return parser


def main() -> int:
    args = build_parser().parse_args()
    return int(args.func(args))


if __name__ == "__main__":
    raise SystemExit(main())
