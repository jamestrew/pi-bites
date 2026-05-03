# pi snacks

collection of pi coding agent extensions to fit my needs

- explore subagent
- less verbose read tool call
- custom (additional) statusline via a script
- _custom_ todo tool
- _custom_ question tool

## Installation

```bash
pi install git:github.com/jamestrew/pi-bites
```

## TODO

- [x] configurable default model for explore
- [x] make this installable via git. don't really care about npm?
- [x] better file fzy finder
- [ ] project-specific explore prompt tweaks
- [ ] better todo tool
  - [x] don't want each tool call to be displayed, the main widget is enough
  - [x] once the full todo list is completed, subsequent agent starts should hide the todo list
  - [x] once the full todo list is completed, the last complete tool call should leave a renderCall
  - [x] tweak tool description? 1 item todo lists not uncommon

- [ ] improve explore tool description? 1 tool call explores not uncommon. seems useless
