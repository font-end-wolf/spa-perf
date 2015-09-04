require('./performance-now');
var zoneJS = require('zone.js');
// these are polyfills for stupid phantomjs
var timelineId = 0;
var timelines = [];
var marks = [];

var ZONED_EVENT_TYPE_MAP = trueMap(['click']);

function trueMap(array) {
    return array.reduce(function(map, type) {
        return map[type] = true && map;
    }, {});
}

var MOUSE_KEY_TYPES = ['focus', 'blur', 'cut', 'copy', 'paste'];
var RELATED_TYPES = {
    'mousedown': trueMap(['mouseup', 'click', 'dblclickx', 'mousemove', 'dragstart', 'drag', 'dragend'].concat(MOUSE_KEY_TYPES)),
    'mousemove': trueMap(['dragstart', 'drag']),
    'mousewheel': {},
    'keydown': trueMap(['keypress', 'keyup'].concat(MOUSE_KEY_TYPES))

};
var NETWORK_PROPS = ['domainLookupStart', 'domainLookupEnd', 'connectStart', 'connectEnd', 'requestStart', 'responseStart', 'responseEnd'];

function createTimelineFromTrigger(e) {
    var tcs = e.target && getTcs(e.target);
    var timeline = {
        id: ++timelineId,
        action: e.type,
        components: tcs,
        created_timestamp: Date.now(),
        time_since_page_load: window.performance.now().toFixed(2)
    };
    if (window.performance.memory) {
        Object.keys(window.performance.memory).forEach(function(key) {
            timeline[key] = window.performance.memory[key] / 1000 / 1000;
        });
    }
    timelines.push(timeline);
    return timeline;
}

function getCurrentTimeline() {
    var currentZone = zoneJS.zone;
    if (!currentZone) {
        return;
    }
    if (!currentZone.timeline) {
        currentZone.timeline = createTimelineFromTrigger(currentZone.event);
        delete currentZone.event;
    }
    return currentZone.timeline;
}

function makeMark(name, detail, timestampOverride, timeline) {
    var mark = {
        timelineId: timeline.id,
        name: name,
        timestamp: ((timestampOverride || window.performance.now()) - timeline.time_since_page_load).toFixed(2)
    };
    if (detail) {
        Object.keys(detail, function(key) {
            mark[key] = detail[key];
        });
    }
    return mark;
}

function getTcs(node, tcs) {
    tcs = tcs || [];
    var thisTc = node.getAttribute && (node.getAttribute('tc') || node.getAttribute('class'));
    if (thisTc) {
        tcs.push(thisTc);
    }
    if (node.children && node.children.length) {
        Array.prototype.slice.call(node.children).forEach(function(child) {
            getTcs(child, tcs);
        });
    }
    return tcs;
}

function tcMutationHandler(nodes) {
    if (nodes.length) {
        //it really shouldn't be possible not to have one of these but in tests it is so null check to be safe
        var tcs = [];
        nodes.forEach(function(node) {
            getTcs(node, tcs);
        });
        var counts = {};
        tcs.forEach(function(tc) {
            var count = counts[tc];
            if (!count) {
                counts[tc] = 1;
            } else {
                counts[tc] = count + 1;
            }
        });
        tcs = [];
        Object.keys(counts).forEach(function(tc) {
            tcs.push(tc + ' ' + counts[tc]);
        });
        perfZone.addMark('render', {
            componenent_list: tcs
        });
    }
}

function collectNodesFromMutation(mutation) {
    var result = [];
    switch (mutation.type) {
        case 'attributes':
            result.concat(mutation.addedNodes).concat(mutation.removedNodes);
            break;
        case 'childList':
            result.push(mutation.target);
            break;
    }
    return result;
}

var componentObserver = new MutationObserver(function(mutations) {
    var nodes = angular.element.unique(mutations.map(collectNodesFromMutation).flatten(1));
    tcMutationHandler(nodes);
});

function riqPerformanceNetworkHandler(url, promise) {
    if (!perfZone.started) {
        return;
    }

    var startMark = perfZone.addMark('network_send', {
        url: url
    });
    var entries = window.performance.getEntriesByType('Resource');
    //if these are about to get maxed we have to clear or we will lose resolution on the network timing
    if (entries.length >= 149) {
        if (window.performance.webkitClearResourceTimings) {
            window.performance.webkitClearResourceTimings();
        }
        //TODO: other browsers?
    }

    function getCallback(eventName) {
        return function() {
            var networkDetail = {
                url: url
            };
            var completionMark = perfZone.addMark(eventName, networkDetail);
            var resourceEntry;
            var entry;
            var entries = window.performance.getEntriesByType('Resource');
            for (var i = entries.length - 1; i >= 0; i--) {
                entry = entries[i];
                //find the entry that started after we made the network request and shares its url
                if (entry.name.has(url)) {
                    if (entry.domainLookupStart > startMark.timestamp) {
                        //get the closest entry to our timeline start in case there have been more since
                        if (!resourceEntry || resourceEntry.domainLookupStart - startMark.timestamp > entry.domainLookupStart - startMark.timestamp) {
                            resourceEntry = entry;
                        }
                    }
                }
            }
            if (resourceEntry) {
                NETWORK_PROPS.forEach(function(networkProp) {
                    perfZone.addMark('network_' + networkProp.underscore(), networkDetail, resourceEntry[networkProp]);
                });
            } else if (eventName !== 'network_error') { // TODO: only log this in debug mode
                console.log('could not find entry for ' + url + ' that started after we sent the request');
            }
        };
    }

    promise.then(getCallback('network_success'), getCallback('network_error'));

}

var origXHR = window.XMLHttpRequest;
window.XMLHttpRequest = function() {
    var xhr = new origXHR(arguments[0]);
    var origOpen = xhr.open;
    var success, error;
    var promise = new Promise(function(resolve, reject) {
        success = resolve;
        error = reject;
    });
    xhr.open = function riqPerfXhrOpen() {
        var url = arguments[1];
        riqPerformanceNetworkHandler(url, promise);
        return origOpen.apply(this, arguments);
    };
    xhr.addEventListener('load', success);
    xhr.addEventListener('abort', error);
    xhr.addEventListener('error', error);
    return xhr;
};



function createTimelineZone(e) {
    var timelineZone = zoneJS.zone.fork({
        beforeTask: function() {
            // console.log('entering zone for handler of ', this.timeline.action);
            perfZone.currentZone = this;
            console.log(perfZone.currentZone.timeline && perfZone.currentZone.timeline.action || perfZone.currentZone.event.type);
        },
        afterTask: function() {
            // console.log('perf zone leave');
        }
    });
    timelineZone.event = e;
    return timelineZone;
}


(function() {
    var delegate = window.EventTarget.prototype.addEventListener;
    window.EventTarget.prototype.addEventListener = function() {
        var handler = arguments[1];
        var type = arguments[0];
        arguments[1] = function() {
            if (ZONED_EVENT_TYPE_MAP[type]) {
                var e = arguments[0];
                var timelineZone = createTimelineZone(e);
                return timelineZone.run(handler, handler, arguments);
            }
            return handler.apply(handler, arguments);
        };
        return delegate.apply(this, arguments);
    };
})();

var perfZone = {};

perfZone.start = function start() {
    componentObserver.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true
    });
    perfZone.started = true;
};

perfZone.stop = function() {
    componentObserver.disconnect();
    perfZone.started = false;
    // clear cached data on stop for memory
    perfZone.popAllTimelines();
    perfZone.popAllMarks();
};

perfZone.addMark = function addMark(name, detail, timestampOverride) {
    var timeline = getCurrentTimeline();
    if (timeline) {
        var mark = makeMark.call(this, name, detail, timestampOverride, timeline);
        marks.push(mark);
        return mark;
    }
};

perfZone.popAllTimelines = function() {
    var popped = timelines;
    timelines = [];
    return popped;
};

perfZone.popAllMarks = function() {
    var popped = marks;
    marks = [];
    return popped;
};

perfZone.start(); //starts by default to make sure to capture the beginning events

createTimelineZone({
    type: 'page_load'
});


module.exports = perfZone;

//FOR DEBUGGING ONLY
if (window) {
    window.perfZone = perfZone;

}