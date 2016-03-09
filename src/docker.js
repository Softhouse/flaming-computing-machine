'use strict'

var Promise = require('bluebird');
var spawn = require('child-process-promise').spawn;
var exec = require('child-process-promise').exec;
var dbHost = process.env.MONGO_HOST || 'localhost';
var sitewatcherHost = process.env.SITEWATCHER_HOST || 'localhost';
var containerLinks;

// EXPORTS
// =============================================================================

/**
* Builds an image given a buildcontext
*
* @param {Object} buildContext - the buldqueue context item containing all the info
*/
exports.build = function (buildContext) {
    var image = getImageNameFromBuild(buildContext);
    return buildImage(buildContext.repo, image);
};

/**
* Starts a container given a buildContext (build)
* Note that the context must have been used to build and image first
*
* @param {Object} buildContext - the buldqueue context item containing all the info
*/
exports.start = function (buildContext) {
  var now = +new Date();
  var name = getTagNameFromBuild(buildContext) + '_' + now;
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
    '-e', 'KATALOG_VHOSTS=default' + (buildContext.endpoint ? '/' + buildContext.endpoint : ''),
    // Give it a virtual host configuration that [Registrator](https://github.com/gliderlabs/registrator) picks up
    '-e', 'SERVICE_NAME=' + (buildContext.endpoint ? buildContext.endpoint : ''),
    getImageNameFromBuild(buildContext)
  ];

  return appendLink(dbHost, args)
    .then(function() {
      return appendLink(sitewatcherHost, args);
    })
    .then(function() {
      return run('docker', args);
    })
    .then(function() {
      return name;
    });
};

/**
* Removes all containers matching the given id's; quickest way to stop a container
*
* Should consider making this in two steps though, like:
*   1. docker stop <containerid>
*   2. docker rm <containerid>
* Which is better, and gives each container the chance for cleaning up before being killed
*
* @param {Array} containerIds - the container id's matching the containers to kill
*/
exports.kill = function (containerIds) {
  return new Promise(function (resolve) {
    containerIds = containerIds.filter(Boolean);
    if (!containerIds.length) {
      return resolve();
    }

    return run('docker', ['rm', '-f'].concat(containerIds))
      .then(resolve);
  });
};

/**
* Returns all the id's of containers running, matching the buildContext
*
* @param {Object} buildContext - the buldqueue context item containing all the info
*/
exports.getRunning = function (buildContext) {
  return runningImages(getTagNameFromBuild(buildContext))
    .then(trimAndSplit(/\n/g));
};

/**
* Returns true or false depending on if there is a container with a given containerName
* Running `exec` instead of `spawn` here, because otherwise piping is complex.
*
* @param {String} containerName - the container name to check
*/
exports.isRunning = function (containerName) {
  return exec('docker ps | grep "' + containerName + '"')
    .then(function (res) {
      return !!(res.stdout.toString());
    })
    .fail(function () {
      return false;
    })
};

// IMAGES
// =============================================================================

/**
* Builds and image from the given repository and tags it with the imageName
*
* @param {String} repo - the url to the git repository
* @param {String} imageName - the name to give the image
*/
function buildImage (repo, imageName) {
  // Builds a container from a repository URL and tags it with an image name:
  return run('docker', ['build', '-t', imageName, repo]);
}

/**
* Function for retriving the ids of the containers, running images given a tag
*
* Running `exec` instead of `spawn` here, because otherwise piping is complex.
* What we do here is:
*   * docker ps -a # list all containers, running or not
*   * grep "<container tag name>" # filter by container tag name
*   * awk '{print $1}' # get the contents of the first column in the output, i.e. the container id's
*
* @param {String} tag - the tag identifying the images
*/
function runningImages (tag) {
  return new Promise(function (resolve) {
    return exec('docker ps -a | grep "' + tag + '" | awk \'{print $1}\'')
      .then(function(res) {
        return resolve(res.stdout.toString());
      })
      .fail(function(err) {
        return resolve(false);
      });
  });
}

// LINKS
// =============================================================================

/**
* Adds a link to the container matching the hostname
*
* @param {String} hostname - then name for the container to link
*/
function appendLink (hostname, args) {
  return getLink(hostname)
    .then(function(link) {
      return args.splice(args.length - 1, 0, '--link', link);
    })
    .catch(function() {
      return;
    });
}

/**
* Retrieves a link for the given hostname
*
* @param {String} hostname - then name for the container to find a link for
*/
function getLink(hostname) {
  return inspectContainerLinks(process.env.HOSTNAME)
    .any(function(link) {
      if (link.match('.*\/' + hostname + '$')) return link.replace(/:\/.*\//,':');
    })
    .catch(function () {
      throw ('no link match for hostname ' + hostname);
    });
}

/**
* Retrieves the links to a container given the cid
*
* @param {String} cid - the cid of the container to inspect
*/
function inspectContainerLinks(cid) {
  return new Promise(function (resolve, reject) {
    if(containerLinks) {
      return resolve(containerLinks);
    }
    return run('docker', ['inspect', '--format="{{json .HostConfig.Links}}"', cid])
      .then(function(res) {
        containerLinks = JSON.parse(res.trim());
        return resolve(containerLinks);
      });
  });
}

// COMMANDS
// =============================================================================

/**
* A simplified `spawn` api
*
* @param {String} cmd - Command to run
* @param {Array} args - Arguments to pass to command
*/
function run (cmd, args) {
  return new Promise(function (resolve, reject) {
    var data = '';
    spawn(cmd, args)
      .progress(function(command) {

        command.stdout.on('data', addToData);
        command.stderr.on('data', addToData);

        function addToData(d) {
          data +=d;
        }

      })
      .then(function () {
        return resolve(data)
      })
      .fail(reject);
  });

}

// HELPER FUNCTIONS
// =============================================================================

/**
* Double function to trim and split a string given a pattern
* Ex:
* Promise().then(trimAndSplit(/\n/g))
*
* @param {String} pattern - the pattern to apply to the replace function
* @param {Array} string - the string to apply the functions on
*/
function trimAndSplit(pattern) {
  return function(string) {
    return string.trim().split(pattern);
  };
}

/**
* Function to extract a valid ImageName from a buildContext
* build.fullName is the Git "<owner>/<repo>", e.g. "Softhouse/laughing-batman"
*
* @param {Object} build - the build context from which to extract the name
*/
function getImageNameFromBuild (buildContext) {
  return buildContext.fullName.toLowerCase();
};

/**
* Function to extract a valid TagName from a buildContext
* "/" is used by docker as a namespace separator, so we must remove it
*
* @param {Object} build - the build context from which to extract the name
*/
function getTagNameFromBuild (buildContext) {
  // "/" is used by docker as a namespace separator, so we must remove it
  // before using it as the name for a new container:
  return getImageNameFromBuild(buildContext).replace(/\//g, '_');
};
