'use strict';
var spawn = require('child_process').spawn;
var exec = require('child_process').exec;
var dbHost = process.env.MONGO_HOST || 'localhost';
var sitewatcherHost = process.env.SITEWATCHER_HOST || 'localhost';
var containerLinks;

exports.build = function doBuild (build, cb) {
  var image = buildToImageName(build);
  buildImage(build.repo, image, function (err, message) {
    cb(err, message);
  });
};

exports.getRunning = function getRunning (build, cb) {
  runningImages(buildToTagName(build), function (err, res) {
    if (err) {
      return cb(err);
    }
    // The response is one container id per line, make an array of it:
    cb(null, res.trim().split(/\n/g));
  });
};

exports.isRunning = function (containerName, cb) {
  exec('docker ps | grep "' + containerName + '"', function (err, stdout) {
    if (err) {
      return cb(null, false);
    }
    stdout = (''+stdout).trim();
    cb(null, !!stdout);
  });
};

exports.kill = function kill (containerIds, cb) {
  containerIds = containerIds.filter(Boolean);
  if (!containerIds.length) {
    // No containers to kill, do nothing...
    return cb();
  }
  // Force remove all given container id's (the quickest way to stop a running container)
  // Should consider making this in two steps though, like:
  //   1. docker stop <containerid>
  //   2. docker rm <containerid>
  // Which is better, and gives each container the chance for cleaning up before being killed
  run('docker', ['rm', '-f'].concat(containerIds), cb);
};

exports.run = function runImage (build, cb) {
  var now = +new Date();
  var name = buildToTagName(build) + '_' + now;
  var args = [
    'run',
    // Run container as daemon
    '-d',
    // Give it a unique and grep-able name (see `runningImages` below)
    '--name', name,
    // Pass the GITHUB_SECRET env var on to the container (used by the API-container)
    '-e', 'GITHUB_SECRET=' + process.env.GITHUB_SECRET,
    // Pass the MONGO_HOST env var on to the container (used by the API-container)
    '-e', 'MONGO_HOST=' + dbHost,
    // Give it a virtual host configuration that [Katalog](https://registry.hub.docker.com/u/joakimbeng/katalog/) picks up
    '-e', 'KATALOG_VHOSTS=default' + (build.endpoint ? '/' + build.endpoint : ''),
    // Give it a virtual host configuration that [Registrator](https://github.com/gliderlabs/registrator) picks up
    '-e', 'SERVICE_NAME=' + (build.endpoint ? build.endpoint : ''),
    buildToImageName(build)
  ];

  // TODO: promisify
  appendLink(dbHost, args, function() {
    appendLink(sitewatcherHost, args, function() {
      run('docker', args, function (err) {
        cb(err, name);
      });
    });
  });
};

function appendLink(hostname, args, cb) {
  getLink(hostname, function(err, link) {
    if(link) {
      args.splice(args.length-1, 0, '--link', link)
    }
    cb();
  });
}

function buildToImageName (build) {
  // build.fullName is GitHub's "<owner>/<repo>", e.g. "Softhouse/laughing-batman"
  // Docker does not allow uppercase letters in image names though:
  return build.fullName.toLowerCase();
};

function buildToTagName (build) {
  // "/" is used by docker as a namespace separator, so we must remove it
  // before using it as the name for a new container:
  return buildToImageName(build).replace(/\//g, '_');
};

function runningImages (tag, cb) {
  // Running `exec` instead of `spawn` here, because otherwise piping is complex.
  // What we do here is:
  //  * docker ps -a # list all containers, running or not
  //  * grep "<container tag name>" # filter by container tag name, used when starting the container in `runImage` above
  //  * awk '{print $1}' # get the contents of the first column in the output, i.e. the container id's
  exec('docker ps -a | grep "' + tag + '" | awk \'{print $1}\'', function (err, stdout) {
    if (err) {
      return cb(null, false);
    }
    cb(null, ''+stdout);
  });
}

function buildImage (repo, imageName, cb) {
  // Builds a container from a repository URL and tags it with an image name:
  run('docker', ['build', '-t', imageName, repo], cb);
}

/**
* A simplified `spawn` api
*
* @param {String} cmd - Command to run
* @param {Array} args - Arguments to pass to command
* @param {Function} cb - Callback to call when done or error
*/
function run (cmd, args, cb) {
  var command = spawn(cmd, args);

  var data = '';

  command.stdout.on('data', function (d) {
    data += d;
  });

  command.stderr.on('data', function (d) {
    data += d;
  });

  command.on('error', function (err) {
    cb(err);
  });

  command.on('close', function (code) {
    if (code !== 0) {
      return cb(new Error(data));
    }
    return cb(null, data);
  });
}

function getLink(hostname, cb) {
  inspectContainerLinks(process.env.HOSTNAME, function(err, res) {
    if (err) {
      return cb(err)
    }
    for(var i = 0; i < res.length; i++) {
      if (res[i].match('.*\/' + hostname + '$')) { // /vagrant_sitewatcher_1:/vagrant_builder_1/xyz
        return cb(null, res[i].replace(/:\/.*\//,':')); // /vagrant_sitewatcher_1:xyz
      }
    }
    return cb('no link match for hostname ' + hostname)
  })
}

function inspectContainerLinks(cid, cb) {
  if(containerLinks) {
    return cb(null, containerLinks);
  }
  run('docker', ['inspect', '--format="{{json .HostConfig.Links}}"', cid], function (err, res) {
    if (err) {
      return cb(err);
    }
    containerLinks = JSON.parse(res.trim());
    return cb(null, containerLinks);
  });
}
