"""`wixy_server.chat_tasks.extract_tasks` — the `wixy-tasks` fenced-block
protocol (decisions/00097). See that module's own docstring for the contract.
"""

from __future__ import annotations

from wixy_server.chat_tasks import TaskItem, extract_tasks


class TestNoBlock:
    def test_ordinary_text_passes_through_unchanged(self) -> None:
        text = "I've made that change — check the Edit tab."
        assert extract_tasks(text) == (text, None)

    def test_a_block_with_a_different_info_string_is_left_alone(self) -> None:
        text = "Here's the diff:\n\n```python\nprint('hi')\n```\n"
        cleaned, tasks = extract_tasks(text)
        assert tasks is None
        assert "```python" in cleaned


class TestSingleBlock:
    def test_a_clean_block_is_parsed_and_stripped(self) -> None:
        text = (
            "I'll add the FAQ link to your menu now.\n\n"
            "```wixy-tasks\n"
            '{"tasks": [{"label": "Add FAQ link to menu", "status": "doing"}]}\n'
            "```\n\n"
            "Working on it…"
        )
        cleaned, tasks = extract_tasks(text)
        assert "wixy-tasks" not in cleaned
        assert "{" not in cleaned
        assert cleaned == "I'll add the FAQ link to your menu now.\n\nWorking on it…"
        assert tasks == [TaskItem(label="Add FAQ link to menu", status="doing")]

    def test_multiple_tasks_all_parse(self) -> None:
        text = (
            "```wixy-tasks\n"
            '{"tasks": ['
            '{"label": "Read the current menu", "status": "done"}, '
            '{"label": "Add the FAQ link", "status": "doing"}, '
            '{"label": "Check the preview", "status": "pending"}'
            "]}\n```"
        )
        _cleaned, tasks = extract_tasks(text)
        assert tasks == [
            TaskItem(label="Read the current menu", status="done"),
            TaskItem(label="Add the FAQ link", status="doing"),
            TaskItem(label="Check the preview", status="pending"),
        ]

    def test_final_all_done_block_alongside_a_closing_summary(self) -> None:
        text = (
            "```wixy-tasks\n"
            '{"tasks": [{"label": "Add FAQ link to menu", "status": "done"}]}\n```\n\n'
            "Done — the FAQ link is in your menu now. Review it in the Edit tab."
        )
        cleaned, tasks = extract_tasks(text)
        assert cleaned == "Done — the FAQ link is in your menu now. Review it in the Edit tab."
        assert tasks == [TaskItem(label="Add FAQ link to menu", status="done")]

    def test_a_block_with_leading_indentation_is_still_found(self) -> None:
        text = (
            '  ```wixy-tasks\n  {"tasks": [{"label": "Do the thing", "status": "pending"}]}\n  ```'
        )
        _cleaned, tasks = extract_tasks(text)
        assert tasks == [TaskItem(label="Do the thing", status="pending")]

    def test_crlf_line_endings_are_tolerated(self) -> None:
        text = '```wixy-tasks\r\n{"tasks": [{"label": "Do the thing", "status": "pending"}]}\r\n```'
        _cleaned, tasks = extract_tasks(text)
        assert tasks == [TaskItem(label="Do the thing", status="pending")]


class TestMultipleBlocksInOneMessage:
    def test_the_last_valid_block_wins(self) -> None:
        text = (
            '```wixy-tasks\n{"tasks": [{"label": "Step one", "status": "doing"}]}\n```\n\n'
            "some narration\n\n"
            '```wixy-tasks\n{"tasks": [{"label": "Step one", "status": "done"}]}\n```'
        )
        cleaned, tasks = extract_tasks(text)
        assert tasks == [TaskItem(label="Step one", status="done")]
        assert "wixy-tasks" not in cleaned
        assert cleaned == "some narration"


class TestMalformedBlocks:
    def test_invalid_json_is_stripped_but_yields_no_tasks(self) -> None:
        text = "Working on it.\n\n```wixy-tasks\nnot json at all\n```"
        cleaned, tasks = extract_tasks(text)
        assert tasks is None
        assert "wixy-tasks" not in cleaned
        assert cleaned == "Working on it."

    def test_missing_tasks_key_yields_no_tasks(self) -> None:
        _cleaned, tasks = extract_tasks('```wixy-tasks\n{"notTasks": []}\n```')
        assert tasks is None

    def test_empty_tasks_array_yields_no_tasks(self) -> None:
        _cleaned, tasks = extract_tasks('```wixy-tasks\n{"tasks": []}\n```')
        assert tasks is None

    def test_an_invalid_status_yields_no_tasks(self) -> None:
        _cleaned, tasks = extract_tasks(
            '```wixy-tasks\n{"tasks": [{"label": "Do it", "status": "in-progress"}]}\n```'
        )
        assert tasks is None

    def test_a_blank_label_yields_no_tasks(self) -> None:
        _cleaned, tasks = extract_tasks(
            '```wixy-tasks\n{"tasks": [{"label": "  ", "status": "pending"}]}\n```'
        )
        assert tasks is None

    def test_a_non_string_label_yields_no_tasks(self) -> None:
        _cleaned, tasks = extract_tasks(
            '```wixy-tasks\n{"tasks": [{"label": 5, "status": "pending"}]}\n```'
        )
        assert tasks is None

    def test_one_malformed_and_one_valid_block_uses_the_valid_one(self) -> None:
        text = (
            '```wixy-tasks\n{"tasks": []}\n```\n\n'
            '```wixy-tasks\n{"tasks": [{"label": "Do it", "status": "pending"}]}\n```'
        )
        cleaned, tasks = extract_tasks(text)
        assert tasks == [TaskItem(label="Do it", status="pending")]
        assert cleaned == ""


class TestBlankLineCollapsing:
    def test_the_block_removal_never_leaves_a_double_blank_line(self) -> None:
        text = (
            "Sentence one.\n\n"
            '```wixy-tasks\n{"tasks": [{"label": "x", "status": "pending"}]}\n```\n\n'
            "Sentence two."
        )
        cleaned, _tasks = extract_tasks(text)
        assert "\n\n\n" not in cleaned
        assert cleaned == "Sentence one.\n\nSentence two."
