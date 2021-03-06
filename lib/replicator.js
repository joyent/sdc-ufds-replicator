/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2014, Joyent, Inc.
 */

var crypto = require('crypto');
var EventEmitter = require('events').EventEmitter;
var util = require('util');

var assert = require('assert-plus');
var backoff = require('backoff');
var ldap = require('ldapjs');
var once = require('once');
var clone = require('clone');
var vasync = require('vasync');

var RemoteDirectory = require('./remote_directory');
var controls = require('./controls/index');


//--- Globals

var PAGE_SIZE = 50;
var INIT_BACKOFF_START = 1000;
var INIT_BACKOFF_MAX = 60000;
var RETRY_MAX = 3;


///--- API

function Replicator(opts) {
    assert.object(opts, 'opts');
    assert.object(opts.log, 'opts.log');
    assert.object(opts.ldapConfig, 'opts.ldapConfig');

    EventEmitter.call(this);

    this.log = opts.log;
    this.ldapConfig = opts.ldapConfig;
    this.baseDN = opts.baseDN || 'o=smartdc';
    this.checkpointDN = opts.checkpointDN || this.baseDN;
    this.checkpointObjectclass = opts.checkpointObjectclass ||
        'sdcreplcheckpoint';
    this.pollInterval = parseInt(opts.pollInterval, 10) || 1000;

    var self = this;
    this._remotes = {};
    this.__defineGetter__('remotes', function () {
        return Object.keys(self._remotes);
    });

    // Valid states:
    // - init: Initializing resources before startup
    // - poll: Polling remote servers for new changes
    // - process: Applying changes in queue
    // - wait: Waiting for local server reconnect
    // - destroy: Shutdown/destroyed
    this._state = 'init';
    this.__defineGetter__('state', function () {
        return self._state;
    });

    this._queue = [];

    this._connect();
}
util.inherits(Replicator, EventEmitter);
module.exports = Replicator;

/**
 * Add remove UFDS instance to replicate from.
 */
Replicator.prototype.addRemote = function addRemote(opts) {
    assert.object(opts);
    assert.string(opts.url);
    var url = opts.url;

    if (this._remotes[url]) {
        this.emit('error', new Error(util.format(
                        'duplicate remote url: %s', url)));
        return;
    }

    var config = clone(opts);
    config.url = url;
    var log = this.log.child({remoteUFDS: url});
    var remote = new RemoteDirectory({
        ldapConfig: config,
        log: log
    });
    remote.connect();

    this._remotes[url] = {
        url: url,
        connection: remote,
        searchnumber: 0 // Last changenumber encountered in search
    };
};

/**
 * Begin replication.
 */
Replicator.prototype.start = function start() {
    assert.equal(this.state, 'init');

    // Reuse all of the sanity checking in resume
    this._setState('wait');
    this.resume();
};

/**
 * Pause replication.
 */
Replicator.prototype.suspend = function suspend(initError) {
    if (this.state === 'destroy') {
        return;
    }
    var self = this;

    // Flush the queue and disconnect from local and remote UFDS instances
    // This will force UFDS versions to be checked on reconnection.
    this._queue = [];
    if (this.client.connected) {
        this.client.unbind();
    }
    this.remotes.forEach(function (url) {
        self._remotes[url].connection.unbind();
    });

    // Enter a backoff loop if issues are encountered during init
    if (initError && !this._initBackoff) {
        var retry = backoff.exponential({
            initialDelay: INIT_BACKOFF_START,
            maxDelay: INIT_BACKOFF_MAX
        });
        retry.on('backoff', this.resume.bind(this));
        retry.on('ready', retry.backoff.bind(retry));
        this._initBackoff = retry;
        retry.backoff();
    }

    this.log.info('activity suspended');
    this._setState('wait');
};

/**
 * Resume replication after a suspend.
 */
Replicator.prototype.resume = function resume() {
    if (this.state !== 'wait') {
        return;
    }
    // Steps to resume polling
    // 1. Reconnect local client
    // 2. Reconnect remote instances
    // 3. Check local/remote versions for validity
    // 4. Query checkpoints from local UFDS
    var self = this;

    // 1. Ensure client connection
    if (!this.client.connected) {
        this.client.connect();
        // client.on('connect') will call us back
        return;
    }

    // 2. Ensure remote instance connections
    var invalid = false;
    this.remotes.forEach(function (url) {
        var remote = self._remotes[url].connection;
        if (!remote.connected) {
            remote.connect();
            remote.once('connect', self.resume.bind(self));
            invalid = true;
        }
    });
    if (invalid) {
        // remote.once('connect') will call us back
        return;
    }

    // 3. Compare local/remote versions
    this.remotes.forEach(function (url) {
        var remote = self._remotes[url].connection;
        if (self.version < remote.version) {
            self.log.fatal({
                localVersion: self.version,
                remoteVersion: remote.version
            }, 'version mismatch');
            invalid = true;
        }
    });
    if (invalid) {
        self.suspend(true);
        return;
    }

    // 4. Initialize checkpoints
    vasync.forEachParallel({
        inputs: this.remotes,
        func: function (url, cb) {
            self._checkpointInit(self._remotes[url], cb);
        }
    }, function (err, res) {
        if (err) {
            self.log.fatal('error during checkpoint init');
            self.suspend(true);
        } else {
            self.log.info('initialize success');
            self._setState('poll');
            // Clear any retry backoff
            if (self._initBackoff) {
                self._initBackoff.reset();
                self._initBackoff = null;
            }
        }
    });
};

/**
 * Halt and destroy the replicator.
 */
Replicator.prototype.destroy = function destroy() {
    this._setState('destroy');
};


///--- Private methods

/**
 * Establish connection to local UFDS instance.
 */
Replicator.prototype._connect = function _connect() {
    if (this.client) {
        throw new Error('already connected');
    }

    var self = this;
    var log = this.log;
    var config = this.ldapConfig;
    config.log = log;
    config.reconnect = config.reconnect || { maxDelay: 10000 };
    config.reconnect.failAfter = Infinity;

    var client = ldap.createClient(config);
    client.on('setup', function (clt, next) {
        clt.bind(config.bindDN, config.bindCredentials, function (err) {
            if (err) {
                log.error({ bindDN: config.bindDN, err: err },
                    'invalid bind credentials');
            }
            next(err);
        });
    });
    // Query local UFDS version
    client.on('setup', function (clt, next) {
      var cb = once(function (err) {
        if (err) {
          self.log.error({err: err}, 'unable to query local UFDS version');
        }
        next(err);
      });
      clt.search('', {scope: 'base'}, function (err, res) {
        if (err) {
          cb(err);
          return;
        }
        res.once('searchEntry', function (item) {
          var version = parseInt(item.object.morayVersion, 10);
          if (version > 0) {
            self.version = version;
            cb();
          } else {
            // Bail out, since the local UFDS must be at least this new for
            // replicator to function properly.  It requires support for the
            // checkpoint-altering control at the very least.
            var issue = new Error('UFDS version too old');
            self.emit('error', issue);
            cb(issue);
          }
        });
        res.once('error', cb);
      });
    });
    client.on('connect', function () {
        log.info({
          bindDN: config.bindDN,
          version: self.version
        }, 'connected and bound');
        self.emit('connect');
        // If the replicator isn't waiting to initialize, it should change
        // state to resume processing/polling.
        if (self.state !== 'init') {
            self.resume();
        }
    });
    client.on('error', function (err) {
        log.warn(err, 'ldap error');
    });
    client.on('close', function () {
        if (!self.destroyed) {
            log.warn('ldap disconnect');
            // suspend processing and polling until connected again
            self.suspend();
        }
    });
    client.on('resultError', function (err) {
        switch (err.name) {
        case 'UnavailableError':
        case 'BusyError':
            log.warn('ldap unavailable');
            self.suspend();
            break;
        default:
            // Other errors are not a centralized concern
            break;
        }
    });
    client.on('connectError', function (err) {
        log.warn(err, 'ldap connection attempt failed');
    });

    this.client = client;
};

/**
 * Transition between replicator states.
 */
Replicator.prototype._setState = function _setState(desired) {
    var self = this;
    if (this.state === desired) {
        return;
    }

    // Define valid state transitions
    function ok_from(choices) {
        return (choices.indexOf(self.state) !== -1);
    }

    var valid = false;
    var action;
    switch (desired) {
    case 'poll':
        valid = ok_from(['wait', 'process']);
        action = this._poll.bind(this);
        break;
    case 'process':
        valid = ok_from(['wait', 'poll']);
        action = this._process.bind(this);
        break;
    case 'destroy':
        // always allow destroy
        valid = true;
        action = this._destroy.bind(this);
        break;
    case 'wait':
        valid = ok_from(['init', 'poll', 'process']);
        action = function () { };
        break;
    case 'init':
        break;
    default:
        // noop for all others
        break;
    }
    if (valid) {
        // allowed transition
        this.log.debug({
            oldState: this.state,
            newState: desired
        }, 'state transition');
        this._state = desired;
        process.nextTick(action);
    } else {
        this.emit('error', new Error('invalid state transition:' +
                    this.state + ' -> ' + desired));
    }
};

/**
 * Poll remote directories for new changelog entries.
 */
Replicator.prototype._poll = function _poll(targetRemote) {
    if (this.state !== 'poll') {
        return;
    }
    var self = this;

    function pollRemote(url) {
        var remote = self._remotes[url];
        var startnum = remote.searchnumber + 1;
        var endnum = startnum + PAGE_SIZE;
        // Verify UFDS version are still OK
        if (self.version < remote.connection.version) {
            // If, through reconnection, the remote has jumped ahead in
            // version, bring things to a halt before something goes awry
            self.suspend(true);
            return;
        }
        remote.connection.poll(startnum, endnum,
            self._enqueue.bind(self, url),
            function (last) {
                if (last === undefined) {
                    // remote is still in the middle of a poll
                    return;
                } else if (last !== 0) {
                    remote.searchnumber = last;
                    // Since new records were found at this remote directory,
                    // it's reasonable to assume there could be more.
                    // Immediately poll this remote for more records
                    self._poll(remote.url);
                } else {
                    // Emit caughtup when poll is empty _and_ it hasn't been
                    // emitted for this searchnumber yet.
                    if (remote.caughtup !== remote.searchnumber) {
                        remote.caughtup = remote.searchnumber;
                        self.emit('caughtup', url, remote.searchnumber);
                    }
                }
            });
    }

    // Indicate that polling has begun.
    // Since 'caughtup' event only signifies that the replicator has fetched
    // all clog entries from a remote system, an additional event is needed to
    // communicated that the queue of changes has been processed.
    this.emit('poll');

    if (targetRemote) {
        pollRemote(targetRemote);
    } else {
        this.remotes.forEach(pollRemote);
    }

    if (!this._timer) {
        this._timer = setTimeout(function () {
            self._timer = null;
            self._poll();
        }, this.pollInterval);
    }
};

/**
 * Shutdown and destroy the replicator.
 */
Replicator.prototype._destroy = function _destroy() {
    var self = this;
    if (this._timer) {
        clearTimeout(this._timer);
        this._timer = null;
    }
    this.destroyed = true;
    this.client.destroy();
    this.remotes.forEach(function (url) {
        self._remotes[url].connection.destroy();
    });
    this.emit('destroy');
    this.log.info('destroyed replicator');
};

/**
 * Record a changelog entry into the queue.
 */
Replicator.prototype._enqueue = function _enqueue(url, result) {
    this._queue.push({
        remote: this._remotes[url],
        change: result
    });
    if (this.state === 'poll') {
        // Begin processing entries if needed
        this._setState('process');
    }
};

/**
 * Process a queued changelog entry.
 */
Replicator.prototype._process = function _process() {
    if (this.state !== 'process') {
        return;
    }
    var self = this;
    var entry = this._queue.shift();

    var done = once(function (err) {
        if (err) {
            self.log.warn({err: err}, 'error during change');
            // Retry a finite amount of times.
            // This should prevent transient connectivity errors from ruining
            // real changes while other unanticipated problems will cause the
            // replicator to bail out.
            entry.retry = (entry.retry) ? (entry.retry + 1) : 1;
            if (entry.retry >= RETRY_MAX) {
                self.log.fatal({entry: entry, err: err},
                    'max retries reach on entry');
                self.emit('error', err);
            } else {
                self._queue.unshift(entry);
            }
        }
        if (self._queue.length !== 0) {
            process.nextTick(self._process.bind(self));
        } else {
            self._setState('poll');
        }
    });

    entry.controls = [];
    var ident = entry.remote.connection.identity;
    if (ident.uuid) {
        // Tag clog entries with the source ufds/changenumber, if possible
        var clogHint = new controls.ChangelogHintRequestControl({
            value: {
                uuid: ident.uuid,
                changenumber: parseInt(entry.change.changenumber, 10)
            }
        });
        entry.controls.push(clogHint);
    }

    // Update the checkpoint on successful action
    var checkpointUpdate = new controls.CheckpointUpdateRequestControl({
        value: {
            dn: entry.remote.checkpoint,
            changenumber: parseInt(entry.change.changenumber, 10)
        }
    });
    entry.controls.push(checkpointUpdate);

    switch (entry.change.changetype) {
        case 'add':
            this._processAdd(entry, done);
            break;
        case 'modify':
            this._processModify(entry, done);
            break;
        case 'delete':
            this._processDel(entry, done);
            break;
        default:
            this.emit('error', new Error('invalid changetype:' +
                        entry.change.changetype));
            break;
    }
};

Replicator.prototype._processAdd = function _processAdd(entry, cb) {
    var self = this;
    var dn = entry.change.targetdn.toString();
    var attrs = entry.change.changes;
    var ctrls = entry.controls;

    function addModify() {
        var changes = [];
        attrs.forEach(function (attr) {
            changes.push(new ldap.Change({
                operation: 'replace',
                modification: new ldap.Attribute({
                    type: attr,
                    vals: attrs[attr]
                })
            }));
        });
        self.client.modify(dn, changes, ctrls, function (err, res) {
            if (err) {
                if (err.name === 'ConstraintViolationError') {
                    // Treat this seriously but move forward
                    self.log.fatal({
                        err: err,
                        changenumber: entry.change.changenumber,
                        dn: dn,
                        remoteUFDS: entry.remote.url
                    }, 'add-modify failure');
                    cb();
                } else {
                    cb(err);
                }
            } else {
                cb();
            }
        });
    }

    this.log.trace({dn: dn}, 'begin add');
    this.client.add(dn, attrs, ctrls, function (err, res) {
        if (err) {
            if (err.name === 'EntryAlreadyExistsError') {
                // Perform a modify instead.  Last write wins
                return addModify();
            } else if (err.name === 'ConstraintViolationError') {
                // Treat this seriously but move forward
                self.log.fatal({
                    err: err,
                    changenumber: entry.change.changenumber,
                    dn: dn,
                    remoteUFDS: entry.remote.url
                }, 'add failure');
                return cb();
            } else {
                // log and try again
                self.log.warn({err: err}, 'error during add');
                return cb(err);
            }
        }
        // success
        self.log.debug({dn: dn}, 'add success');
        return cb();
    });
};

Replicator.prototype._processModify = function _processModify(entry, cb) {
    // Possible scenarios:
    // 1. Old and updated entries match the filter - modify
    // 2. Neither matches filter - ignore
    // 3. Old matches, updated doesn't - delete
    // 4. Old doesn't match, updated does - modify
    // 5. Local not found, updated matches - add
    var self = this;
    var dn = entry.change.targetdn.toString();
    var changes = entry.change.changes;

    function matchesFilter(obj) {
        var queries = entry.change.queries;
        for (var i = 0; i < queries.length; i++) {
            if (queries[i].matches(obj)) {
                return true;
            }
        }
        return false;
    }
    function evalOptions(old) {
        var updated = {};
        var oldMatches = false;
        if (old !== null) {
            updated = clone(old);
            oldMatches = matchesFilter(old);
        }
        changes.forEach(function (change) {
            ldap.Change.apply(change, updated);
        });
        var newMatches = matchesFilter(updated);

        if (!oldMatches && !newMatches) {
            // scenario 2: ignore
            return cb();
        } else if (newMatches && old !== null) {
            // scenarios 1 & 4: modify
            self.client.modify(dn, changes, entry.controls, function (err) {
                if (!err) {
                    self.log.debug({dn: dn}, 'modify success');
                }
                cb(err);
            });
        } else if (oldMatches && !newMatches) {
            // scenarios 3: delete
            self.client.del(dn, entry.controls, function (err) {
                if (!err) {
                    self.log.debug({dn: dn}, 'modify-delete success');
                }
                cb(err);
            });
        } else if (old === null && newMatches) {
            // scenarios 5: add
            self.client.add(dn, updated, entry.controls, function (err) {
                if (!err) {
                    self.log.debug({dn: dn}, 'modify-add success');
                }
                cb(err);
            });
        } else {
            // Shouldn't be possible, squawk about it
            self.log.error('impossible modify combination');
            return cb();
        }
        return null;
    }

    this.log.trace({dn: dn}, 'begin modify');
    this.client.search(dn, {scope: 'base'}, function (err, res) {
        if (err) {
            return cb(err);
        }
        res.once('searchEntry', function (item) {
            res.removeAllListeners();
            evalOptions(item.object);
        });
        res.once('error', function (err2) {
            if (err2.name === 'NoSuchObjectError') {
                evalOptions(null);
            } else {
                cb(err2);
            }
        });
        return null;
    });
};

Replicator.prototype._processDel = function _processDel(entry, cb) {
    // Three scenarios:
    // 1. Entry does not exist locally - ignore
    // 2. Entry does exist locally but does not match filter - ignore
    // 2. Entry does exist locally and does match filter - delete
    var self = this;
    var log = this.log.child({op: 'delete', dn: dn});
    var dn = entry.change.targetdn.toString();
    function performDelete() {
        self.client.del(dn, entry.controls, function (err) {
            if (err) {
                if (err.name !== 'NotAllowedOnNonLeafError') {
                    return cb(err);
                } else {
                    // Log this, but still succeed
                    log.warn('skipping delete of non-leaf node');
                }
            }
            log.debug('success');
            return cb();
        });
    }

    // Log at trace instead of debug due to processing of non-matching entries
    log.trace('begin');
    // Check for an existing item at that DN
    this.client.search(dn, {scope: 'base'}, function (err, res) {
        if (err) {
            return cb(err);
        }
        res.once('searchEntry', function (item) {
            res.removeAllListeners();
            // The item needs to match a queries to be deleted
            var queries = entry.change.queries;
            for (var i = 0; i < queries.length; i++) {
                var query = queries[i];
                if (query.matches(item.object)) {
                    return performDelete();
                }
            }
            // No matches. We're not meant to delete this, so report success.
            log.trace('does not match queries');
            return cb();
        });
        res.once('end', cb.bind(null, null)); // Not found
        res.once('error', function (err2) {
            // If the item doesn't exist in the directory, we can consider the
            // deletion a success.
            if (err2.name === 'NoSuchObjectError') {
                log.trace('not found locally');
                cb();
            } else {
                cb(err2);
            }
        });
        return null;
    });
};


/**
 * Initialize local checkpoint for remote UFDS instance.
 */
Replicator.prototype._checkpointInit = function _checkpointInit(remote, cb) {
    var self = this;
    cb = once(cb);

    this._checkpointGet(remote.connection.identity, function (err, res) {
        if (err && err.name !== 'NoSuchObjectError') {
            return cb(err);
        }
        if (res) {
            // Found a checkpoint
            remote.searchnumber = parseInt(res.changenumber, 10);
            remote.checkpoint = res.dn.toString();

            self.log.debug({
                url: remote.url,
                changenumber: res.changenumber,
                dn: res.dn
            }, 'initialized from existing checkpoint');
            cb(null);
        } else {
            // Need to create one
            self._checkpointAdd(remote, cb);
        }
        return null;
    });
};

/**
 * Query local UFDS for a checkpoint record.
 */
Replicator.prototype._checkpointGet = function _checkpointGet(ident, cb) {
    var self = this;
    cb = once(cb);

    // Work around how Moray handles non-indexed fields
    function ocFilter(input) {
        return new ldap.AndFilter({
            filters: [
                new ldap.EqualityFilter({
                    attribute: 'objectclass',
                    value: self.checkpointObjectclass
                }),
                input
            ]
        });
    }

    var filter = new ldap.OrFilter({
        filters: [
            ocFilter(new ldap.EqualityFilter({
                attribute: 'url',
                value: ident.url
            }))
        ]
    });
    if (ident.uuid) {
        // Search by UUID if server identity supports it
        filter.addFilter(ocFilter(new ldap.EqualityFilter({
            attribute: 'uuid',
            value: ident.uuid
        })));
    }

    var opts = {
        filter: filter,
        scope: 'sub'
    };

    this.client.search(this.baseDN, opts, function (err, res) {
        if (err) {
            cb(err);
        }
        var result = null;
        res.on('searchEntry', function (entry) {
            if (result) {
                return cb(new Error(ident.url + ': multiple checkpoints'));
            }
            var obj = entry.object;
            result = {
                dn: obj.dn,
                changenumber: obj.changenumber
            };
            return null;
        });
        res.on('end', function () {
            cb(null, result);
        });
        res.on('error', function (err2) {
            cb(err2);
        });
        return null;
    });
};

/**
 * Add a checkpoint record to local UFDS.
 */
Replicator.prototype._checkpointAdd = function _checkpointAdd(remote, cb) {
    var self = this;
    cb = once(cb);

    var ident = remote.connection.identity;
    var entry = {
        url: ident.url,
        objectclass: [this.checkpointObjectclass],
        changenumber: 0,
        query: remote.connection.rawQueries
    };
    var dn;

    if (ident.uuid) {
        // uuid style checkpoint
        entry.uuid = ident.uuid;
        dn = util.format('uuid=%s, %s', ident.uuid, this.checkpointDN);
    } else {
        // old hashed-url style checkpoint
        var urlHash = crypto.createHash('md5').update(ident.url).digest('hex');
        entry.uid = urlHash;
        dn = util.format('uid=%s, %s', urlHash, this.checkpointDN);
    }

    this.client.add(dn, entry, function (err) {
        if (err) {
            return cb(err);
        }
        remote.checkpoint = dn;
        remote.searchnumber = 0;
        self.log.debug({url: ident.url, changenumber: 0}, 'checkpoint add');
        return cb(null);
    });
};
