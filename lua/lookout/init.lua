local M = {}
local api = vim.api
local root = vim.fs.dirname(vim.fs.dirname(vim.fs.dirname(debug.getinfo(1, 'S').source:sub(2))))
local config = { hosts = {}, node = 'node', state_dir = vim.fn.stdpath('state') .. '/lookout' }
local runtime = { seq = 0, pending = {}, partial = '', view = {}, rows = {}, profile = nil }
local ns = api.nvim_create_namespace('lookout')

local function notify(text, level) vim.notify(text, level or vim.log.levels.INFO, { title = 'Lookout' }) end
local function valid(win) return win and api.nvim_win_is_valid(win) end
local function tab_valid() return runtime.tab and api.nvim_tabpage_is_valid(runtime.tab) end
local function buf_valid(buf) return buf and api.nvim_buf_is_valid(buf) end
local function lines(text)
  local result = vim.split(text or '', '\n', { plain = true })
  if #result > 1 and result[#result] == '' then table.remove(result) end
  return result
end
local function content(buf, text)
  vim.bo[buf].modifiable = true
  api.nvim_buf_set_lines(buf, 0, -1, false, type(text) == 'table' and text or lines(text))
  vim.bo[buf].modifiable = false
end
local function scratch(name, ft)
  local buf = api.nvim_create_buf(false, true)
  api.nvim_buf_set_name(buf, name .. '/' .. buf)
  vim.bo[buf].bufhidden = 'wipe'
  vim.bo[buf].swapfile = false
  vim.bo[buf].filetype = ft or ''
  return buf
end
local function popup(text, ft)
  local buf = scratch('lookout://help', ft or 'markdown')
  content(buf, text)
  local win = api.nvim_open_win(buf, true, { relative = 'editor', style = 'minimal', border = 'rounded',
    width = math.max(20, math.min(100, vim.o.columns - 6)), height = math.max(4, math.min(28, vim.o.lines - 6)), row = 2, col = 3 })
  vim.bo[buf].bufhidden = 'wipe'
  vim.keymap.set('n', 'q', function() if valid(win) then api.nvim_win_close(win, true) end end, { buffer = buf })
end
local function current_file()
  local id = vim.b.lookout_file or runtime.selected
  for _, file in ipairs(runtime.view.files or {}) do if file.id == id then return file end end
end
local function target_key()
  local target = runtime.view.target or {}
  return table.concat({ runtime.profile or '', target.session or '', target.chat or '', target.changeset or '' }, '\n')
end

local function request(method, params, callback)
  if not runtime.job then notify('Run :Lookout connect first', vim.log.levels.WARN); return end
  runtime.seq = runtime.seq + 1
  local id = runtime.seq
  runtime.pending[id] = callback or function() end
  vim.fn.chansend(runtime.job, vim.json.encode({ id = id, method = method, params = params or {} }) .. '\n')
end
M._request = request

local function retire_composer()
  if runtime.draft_timer then runtime.draft_timer:stop(); runtime.draft_timer:close(); runtime.draft_timer = nil end
  if buf_valid(runtime.feedbackbuf) then
    if runtime.feedback_target == target_key() then
      request('draft', { text = table.concat(api.nvim_buf_get_lines(runtime.feedbackbuf, 0, -1, false), '\n') })
    end
    api.nvim_buf_delete(runtime.feedbackbuf, { force = true })
  end
  runtime.feedbackbuf, runtime.feedback_target = nil, nil
end

local function close()
  if tab_valid() then
    if #api.nvim_list_tabpages() == 1 then vim.cmd('tabnew') end
    api.nvim_set_current_tabpage(runtime.tab)
    vim.cmd('tabclose')
  end
  runtime.tab, runtime.sidebar, runtime.before, runtime.after = nil, nil, nil, nil
end

local help = [[
Lookout

Review follows the agent without pausing it. Displayed diffs stay still until r.

<Enter>  Open selected file or activity entry
f        Jump to files
t        Jump to activity timeline
T        Open the recent activity timeline in a searchable buffer
]c / [c  Native next / previous diff hunk (inside a diff)
r        Refresh frozen snapshot
s        Mark current file seen at the displayed version
S        Mark all displayed files seen
a        Toggle Since reviewed / All changes
c        Comment on file; select lines first for a range comment
F        Compose feedback, including collected comments
gS       Select another session/chat
gC       Select another changeset scope (separate baseline)
?        Help
q        Close review; observation continues while Neovim is running

Feedback is a normal editable buffer. :write saves the draft locally.
<LocalLeader>s sends it explicitly; <LocalLeader>q closes the composer.
Accepted means the host acknowledged it, not that the model acted on it.

:Lookout clear discards draft comments after confirmation.
Check the agent chat before resending feedback with uncertain delivery.
Review checkpoints are personal and local to this machine. Nothing is committed.
]]

local function bind(buf)
  local map = function(key, fn, desc) vim.keymap.set('n', key, fn, { buffer = buf, silent = true, desc = desc }) end
  map('r', function() notify('Refreshing snapshot…'); request('refresh') end, 'Refresh review')
  map('s', function() local file = current_file(); if file then request('seen', { id = file.id }) end end, 'Mark file seen')
  map('S', function() request('seen') end, 'Mark all files seen')
  map('a', function() request('view', { mode = runtime.view.mode == 'all' and 'since' or 'all' }) end, 'Toggle review baseline')
  map('c', function() M.comment() end, 'Comment on file')
  vim.keymap.set('x', 'c', ":<C-u>lua require('lookout').visual_comment()<CR>", { buffer = buf, silent = true, desc = 'Comment on selected lines' })
  map('F', function() M.feedback() end, 'Compose feedback')
  map('gS', function() M.sessions() end, 'Select session')
  map('gC', function() M.scope() end, 'Select changeset')
  map('q', close, 'Close review')
  map('?', function() popup(help) end, 'Review help')
  map('f', function()
    if valid(runtime.sidebar) then api.nvim_set_current_win(runtime.sidebar); api.nvim_win_set_cursor(runtime.sidebar, { runtime.first_file or 1, 0 }) end
  end, 'Jump to files')
  map('t', function()
    if valid(runtime.sidebar) then api.nvim_set_current_win(runtime.sidebar); api.nvim_win_set_cursor(runtime.sidebar, { runtime.first_activity or 1, 0 }) end
  end, 'Jump to activity')
  map('T', function()
    local entries = {}
    for _, turn in ipairs(runtime.view.timeline or {}) do
      entries[#entries + 1] = ('## %s%s\n\n%s\n\n%s'):format(turn.time or '', turn.active and ' · working' or '', turn.text or '', turn.response or '')
    end
    popup(table.concat(entries, '\n\n'))
  end, 'Open recent activity')
end

local function ensure_layout()
  if tab_valid() and valid(runtime.sidebar) and valid(runtime.before) and valid(runtime.after) then return end
  vim.cmd('tabnew')
  runtime.tab = api.nvim_get_current_tabpage()
  runtime.sidebar = api.nvim_get_current_win()
  runtime.sidebuf = scratch('lookout://overview', 'lookout')
  api.nvim_win_set_buf(runtime.sidebar, runtime.sidebuf)
  bind(runtime.sidebuf)
  vim.cmd('rightbelow vsplit')
  runtime.before = api.nvim_get_current_win()
  runtime.beforebuf = scratch('lookout://before')
  api.nvim_win_set_buf(runtime.before, runtime.beforebuf)
  bind(runtime.beforebuf)
  vim.cmd('rightbelow vsplit')
  runtime.after = api.nvim_get_current_win()
  runtime.afterbuf = scratch('lookout://after')
  api.nvim_win_set_buf(runtime.after, runtime.afterbuf)
  bind(runtime.afterbuf)
  for _, win in ipairs({ runtime.before, runtime.after }) do
    vim.wo[win].number = true; vim.wo[win].wrap = false
  end
  vim.wo[runtime.sidebar].wrap = false
  vim.wo[runtime.sidebar].winfixwidth = true
  api.nvim_win_set_width(runtime.sidebar, math.min(42, math.floor(vim.o.columns / 3)))
  vim.keymap.set('n', '<CR>', function()
    local row = runtime.rows[api.nvim_win_get_cursor(runtime.sidebar)[1]]
    if not row then return end
    if row.file then M._show_file(row.file, true) end
    if row.turn then popup((row.turn.text or '') .. '\n\n' .. (row.turn.response or '')) end
  end, { buffer = runtime.sidebuf, desc = 'Open activity or file' })
  api.nvim_set_current_win(runtime.sidebar)
end

local function side_text(side, path)
  if not side or side == vim.NIL then return '', '[absent]' end
  if side.kind == 'text' then return side.text or '', (side.uri or path):gsub('^file://', '') end
  return ('[%s]\n%s'):format(side.kind, side.error or 'Metadata-only entry; content is not loaded into the diff.'), path
end

function M._show_file(file, focus)
  if not valid(runtime.before) or not valid(runtime.after) then return end
  runtime.selected = file.id
  for _, tuple in ipairs({ { runtime.before, runtime.beforebuf, file.before, 'before' }, { runtime.after, runtime.afterbuf, file.after, 'after' } }) do
    local win, buf, side, which = unpack(tuple)
    local saved = api.nvim_win_get_cursor(win)
    local text, label = side_text(side, file.path)
    api.nvim_win_call(win, function() vim.cmd('diffoff') end)
    content(buf, text)
    vim.b[buf].lookout_file = file.id
    vim.b[buf].lookout_side = which
    vim.bo[buf].filetype = vim.filetype.match({ filename = file.path }) or ''
    vim.bo[buf].endofline = text:sub(-1) == '\n'
    vim.wo[win].winbar = ('%s · %s'):format(which == 'before' and (runtime.view.mode == 'all' and 'Original' or 'Review baseline') or 'Snapshot', label):gsub('%%', '%%%%')
    api.nvim_win_set_cursor(win, { math.min(saved[1], api.nvim_buf_line_count(buf)), 0 })
    api.nvim_win_call(win, function() vim.cmd('diffthis') end)
    api.nvim_buf_clear_namespace(buf, ns, 0, -1)
    for _, note in ipairs(runtime.view.notes or {}) do
      if note.file == file.id and note.side == which and note.first and note.snapshot == runtime.view.snapshot
        and side and side ~= vim.NIL and side.hash == note.contentHash then
        local row = math.min(note.first, api.nvim_buf_line_count(buf)) - 1
        api.nvim_buf_set_extmark(buf, ns, row, 0, { virt_text = { { '  💬 ' .. (note.snapshot ~= runtime.view.snapshot and '[earlier snapshot] ' or '') .. note.text, 'Comment' } }, virt_text_pos = 'eol' })
      end
    end
  end
  if focus then api.nvim_set_current_win(runtime.after) end
end

local function render_sidebar()
  if not valid(runtime.sidebar) or not buf_valid(runtime.sidebuf) then return end
  local view = runtime.view
  local cursor = api.nvim_win_get_cursor(runtime.sidebar)
  local prior_row = runtime.rows[cursor[1]]
  local text = { 'Lookout', '', view.host or 'No host', view.status or 'Disconnected',
    (view.activity or 'Idle') .. (view.dirty and ' · NEW CHANGES' or ''), '',
    view.target and view.target.label or 'Select a session', view.repository or '',
    view.mode == 'all' and 'All changes' or 'Since reviewed',
    ('%d comments · %s'):format(#(view.notes or {}), view.delivery and view.delivery.state or 'no feedback sent'), '',
    'Activity (Enter for context)',
  }
  runtime.rows = {}; runtime.first_activity = #text + 1
  for index, turn in ipairs(view.timeline or {}) do
    if index > 6 then break end
    local time = (turn.time or ''):match('T(%d%d:%d%d)') or ''
    text[#text + 1] = ('%s %s %s'):format(turn.active and '●' or '·', time, turn.text or '')
    runtime.rows[#text] = { turn = turn }
  end
  text[#text + 1] = ''; text[#text + 1] = 'Files (Enter to inspect)'
  runtime.first_file = #text + 1
  local selected_row
  for _, file in ipairs(view.files or {}) do
    local path = file.path
    if view.repository then
      local directory = view.repository:gsub('^file://', ''):gsub('/$', '') .. '/'
      if path:sub(1, #directory) == directory then path = path:sub(#directory + 1) end
    end
    text[#text + 1] = (file.seen and '✓ ' or '  ') .. path
    runtime.rows[#text] = { file = file }
    if file.id == runtime.selected then selected_row = #text end
  end
  if #(view.files or {}) == 0 then text[#text + 1] = view.snapshot and 'No outstanding changes' or 'No snapshot loaded' end
  text[#text + 1] = ''; text[#text + 1] = 'r refresh · s seen · F feedback'
  text[#text + 1] = 'a baseline · f files · ? help'
  local preserved_row
  for row, entry in pairs(runtime.rows) do
    if prior_row and ((entry.file and prior_row.file and entry.file.id == prior_row.file.id)
      or (entry.turn and prior_row.turn and entry.turn.id == prior_row.turn.id)) then preserved_row = row end
  end
  content(runtime.sidebuf, text)
  api.nvim_win_set_cursor(runtime.sidebar, { preserved_row or math.min(cursor[1], #text), 0 })
end

local function receive(message)
  if message.id then
    local callback = runtime.pending[message.id]; runtime.pending[message.id] = nil
    if message.error then notify(message.error, vim.log.levels.ERROR) end
    if callback then callback(message.result ~= vim.NIL and message.result or nil, message.error) end
  elseif message.event == 'problem' then
    if runtime.last_problem ~= message.data then notify(message.data, vim.log.levels.WARN); runtime.last_problem = message.data end
  elseif message.event == 'view' then
    local previous_delivery = runtime.view.delivery
    runtime.view = message.data
    local delivery = runtime.view.delivery
    if delivery and (delivery.state == 'failed' or delivery.state == 'uncertain')
      and (not previous_delivery or previous_delivery.id ~= delivery.id or previous_delivery.state ~= delivery.state) then
      notify('Feedback ' .. delivery.state .. ': ' .. (delivery.reason or 'Your draft is saved.'), vim.log.levels.WARN)
    end
    if runtime.view.delivery and runtime.view.delivery.state == 'accepted'
      and runtime.submitted_text and buf_valid(runtime.feedbackbuf) then
      local existing = table.concat(api.nvim_buf_get_lines(runtime.feedbackbuf, 0, -1, false), '\n')
      if existing == runtime.submitted_text then
        api.nvim_buf_set_lines(runtime.feedbackbuf, 0, -1, false, { '' })
        vim.bo[runtime.feedbackbuf].modified = false
      end
      runtime.submitted_text = nil
    end
    render_sidebar()
    if tab_valid() then
      local file = current_file() or (runtime.view.files or {})[1]
      if file then M._show_file(file, false)
      elseif buf_valid(runtime.beforebuf) and buf_valid(runtime.afterbuf) then
        runtime.selected = nil
        content(runtime.beforebuf, 'No outstanding changes'); content(runtime.afterbuf, '')
      end
    end
  elseif message.event == 'activity' then
    if message.data.status == 'connected' then runtime.last_problem = nil end
    for key, value in pairs(message.data) do runtime.view[key] = value end
    render_sidebar()
  end
end

local function start_helper()
  if runtime.job then return true end
  if vim.fn.executable(config.node) == 0 then notify('Node.js 24+ is required', vim.log.levels.ERROR); return false end
  if vim.fn.filereadable(root .. '/dist/helper.mjs') == 0 then notify('Helper missing. Run npm ci && npm run build in ' .. root, vim.log.levels.ERROR); return false end
  runtime.partial = ''
  local job = vim.fn.jobstart({ config.node, root .. '/dist/helper.mjs' }, {
    on_stdout = function(_, data)
      local chunk = runtime.partial .. table.concat(data, '\n')
      local start = 1
      while true do
        local newline = chunk:find('\n', start, true)
        if not newline then runtime.partial = chunk:sub(start); break end
        local line = chunk:sub(start, newline - 1); start = newline + 1
        if line ~= '' then
          local ok, message = pcall(vim.json.decode, line)
          if ok then vim.schedule(function() receive(message) end) end
        end
      end
    end,
    on_stderr = function(_, data)
      local message = table.concat(data, '\n')
      if message:match('%S') then vim.schedule(function() notify('Review helper: ' .. message, vim.log.levels.WARN) end) end
    end,
    on_exit = function(_, code)
      runtime.job = nil
      vim.schedule(function()
        runtime.view.status = 'Helper stopped'; render_sidebar()
        for _, callback in pairs(runtime.pending) do callback(nil, 'Helper stopped') end
        runtime.pending = {}
        if code ~= 0 then notify('Review helper exited; drafts saved before exit can be restored on reconnect', vim.log.levels.ERROR) end
      end)
    end,
  })
  if job <= 0 then notify('Could not start review helper', vim.log.levels.ERROR); return false end
  runtime.job = job
  return true
end

function M.setup(options) config = vim.tbl_deep_extend('force', config, options or {}) end

function M.connect(name)
  local function chosen(profile_name)
    if not profile_name then return end
    local profile = config.hosts[profile_name]
    if not profile then notify('Unknown host profile: ' .. profile_name, vim.log.levels.ERROR); return end
    if not start_helper() then return end
    local token = profile.token_env and vim.env[profile.token_env] or nil
    if profile.token_file then
      local ok, value = pcall(vim.fn.readfile, vim.fn.expand(profile.token_file))
      if not ok then notify('Could not read host token file', vim.log.levels.ERROR); return end
      token = vim.trim(table.concat(value, '\n'))
    end
    retire_composer()
    runtime.profile = profile_name
    notify('Connecting to ' .. profile_name .. '…')
    request('connect', { name = profile_name, url = profile.url, token = token, stateDir = config.state_dir }, function(result, err)
      if err then M.open(); return end
      if result and result.restored then M.open() else M.sessions() end
    end)
  end
  if name and name ~= '' then chosen(name); return end
  local names = vim.tbl_keys(config.hosts); table.sort(names)
  if #names == 0 then notify('Configure hosts in require("lookout").setup({ hosts = … })', vim.log.levels.WARN)
  elseif #names == 1 then chosen(names[1]) else vim.ui.select(names, { prompt = 'Agent host:' }, chosen) end
end

local function choose_changeset(session, chat)
  request('changesets', { session = session, chat = chat }, function(entries, err)
    if err then return end
    if not entries or #entries == 0 then notify('This host exposes no static changesets for the selected chat', vim.log.levels.WARN); return end
    table.sort(entries, function(a, b)
      local rank = { session = 1, branch = 2, uncommitted = 3 }
      return (rank[a.changeKind] or 4) < (rank[b.changeKind] or 4)
    end)
    local function select(entry)
      if not entry then return end
      ensure_layout()
      retire_composer()
      request('select', { session = session, chat = chat, changeset = entry.uriTemplate, label = entry.label })
    end
    if #entries == 1 then select(entries[1]) else vim.ui.select(entries, { prompt = 'Changes to review:', format_item = function(entry) return entry.label .. ' (' .. entry.changeKind .. ')' end }, select) end
  end)
end

function M.sessions()
  request('sessions', {}, function(sessions, err)
    if err then return end
    if not sessions or #sessions == 0 then notify('No sessions. Start a task through a terminal AHP client, then try again.'); return end
    vim.ui.select(sessions, { prompt = 'Review session:', format_item = function(session) return session.title or session.resource end }, function(session)
      if not session then return end
      request('chats', { session = session.resource }, function(chats, chat_error)
        if chat_error then return end
        if not chats or #chats == 0 then notify('No visible chats in this session'); return end
        local function chosen(chat) if chat then choose_changeset(session.resource, chat.resource) end end
        if #chats == 1 then chosen(chats[1]) else vim.ui.select(chats, { prompt = 'Feedback recipient:', format_item = function(chat) return chat.title or chat.resource end }, chosen) end
      end)
    end)
  end)
end

function M.scope()
  local target = runtime.view.target
  if target then choose_changeset(target.session, target.chat) else M.sessions() end
end

function M.open()
  if not runtime.job then M.connect(); return end
  ensure_layout(); api.nvim_set_current_tabpage(runtime.tab); render_sidebar()
  local file = current_file() or (runtime.view.files or {})[1]
  if file then M._show_file(file, false) end
end

function M.comment(first, last)
  local file = current_file()
  local side = vim.b.lookout_side
  local snapshot = runtime.view.snapshot
  vim.ui.input({ prompt = file and 'Review comment: ' or 'General feedback: ' }, function(text)
    if text and vim.trim(text) ~= '' then
      request('comment', { file = file and file.id, side = side, first = first, last = last, text = text, snapshot = snapshot })
    end
  end)
end

function M.visual_comment()
  local first, last = vim.fn.line("'<"), vim.fn.line("'>")
  M.comment(math.min(first, last), math.max(first, last))
end

function M.feedback()
  request('feedback', {}, function(text, err)
    if err then return end
    if buf_valid(runtime.feedbackbuf) then
      local windows = vim.fn.win_findbuf(runtime.feedbackbuf)
      if #windows > 0 then api.nvim_set_current_win(windows[1]); return end
      vim.cmd('botright 12split')
      api.nvim_win_set_buf(0, runtime.feedbackbuf)
      return
    end
    vim.cmd('botright 12new')
    local buf = scratch('lookout://feedback', 'markdown')
    runtime.feedbackbuf = buf
    runtime.feedback_target = target_key()
    api.nvim_win_set_buf(0, buf)
    vim.bo[buf].buftype = 'acwrite'; vim.bo[buf].bufhidden = 'hide'
    api.nvim_buf_set_lines(buf, 0, -1, false, lines(text or ''))
    vim.bo[buf].modified = false
    vim.wo.winbar = 'Feedback · ' .. ((runtime.view.target or {}).chat or '') .. ' · <LocalLeader>s send · :w save draft'
    local function draft()
      local value = table.concat(api.nvim_buf_get_lines(buf, 0, -1, false), '\n')
      if runtime.feedback_target ~= target_key() then
        notify('This feedback belongs to an earlier review; reopen feedback for the current chat', vim.log.levels.WARN)
        return nil
      end
      request('draft', { text = value }, function(_, save_error)
        if not save_error and buf_valid(buf) and table.concat(api.nvim_buf_get_lines(buf, 0, -1, false), '\n') == value then vim.bo[buf].modified = false end
      end)
      return value
    end
    api.nvim_create_autocmd('BufWriteCmd', { buffer = buf, callback = draft })
    api.nvim_create_autocmd({ 'TextChanged', 'TextChangedI' }, { buffer = buf, callback = function()
      if runtime.draft_timer then runtime.draft_timer:stop(); runtime.draft_timer:close() end
      runtime.draft_timer = vim.uv.new_timer()
      runtime.draft_timer:start(300, 0, vim.schedule_wrap(function() if buf_valid(buf) then draft() end end))
    end })
    vim.keymap.set('n', '<LocalLeader>s', function()
      local value = draft()
      if not value then return end
      runtime.submitted_text = value
      request('send', { text = value }, function(_, send_error)
        if not send_error then notify('Feedback submitted; delivery status is shown in the review overview') end
      end)
    end, { buffer = buf, desc = 'Send review feedback' })
    vim.keymap.set('n', '<LocalLeader>q', function() draft(); vim.cmd('close') end, { buffer = buf, desc = 'Save draft and close' })
  end)
end

function M.command(opts)
  local action, argument = opts.fargs[1] or 'open', opts.fargs[2]
  if action == 'connect' then M.connect(argument)
  elseif action == 'open' then M.open()
  elseif action == 'sessions' then M.sessions()
  elseif action == 'scope' then M.scope()
  elseif action == 'refresh' then request('refresh')
  elseif action == 'seen' then local file = current_file(); if argument == 'all' then request('seen') elseif file then request('seen', { id = file.id }) end
  elseif action == 'all' or action == 'since' then request('view', { mode = action })
  elseif action == 'comment' then M.comment(opts.range > 0 and opts.line1 or nil, opts.range > 0 and opts.line2 or nil)
  elseif action == 'feedback' then M.feedback()
  elseif action == 'disconnect' then request('disconnect')
  elseif action == 'clear' then vim.ui.select({ 'Keep comments', 'Discard comments and draft' }, { prompt = 'Clear review feedback?' }, function(choice)
    if choice == 'Discard comments and draft' then retire_composer(); request('clear') end
  end)
  elseif action == 'help' then popup(help)
  else notify('Unknown action: ' .. action, vim.log.levels.ERROR) end
end

api.nvim_create_autocmd('VimLeavePre', { callback = function()
  if runtime.draft_timer then runtime.draft_timer:stop(); runtime.draft_timer:close(); runtime.draft_timer = nil end
  if runtime.job then
    if buf_valid(runtime.feedbackbuf) then request('draft', { text = table.concat(api.nvim_buf_get_lines(runtime.feedbackbuf, 0, -1, false), '\n') }) end
    vim.fn.chanclose(runtime.job, 'stdin')
    vim.fn.jobwait({ runtime.job }, 1000)
  end
end })

M._runtime = runtime
M._receive = receive
return M
