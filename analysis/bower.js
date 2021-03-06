'use strict';

const bower = require('bower');
const child_process = require('child_process');
const url = require('url');

/**
 * Service for communicating with Bower on the local machine.
 * Provides support for installing packages, enumerating their dependencies etc...
 * Accurate information will only be obtained by using Bower for one main package at a time.
 * Sadly, this means a flow of "install, dependencies, prune".
 */
class Bower {
  /**
   * Clean up (rm -rf) the local Bower working area.
   * This deletes the installs for this directory, not the Bower cache (usually stored in ~/.cache/bower).
   */
  prune() {
    return new Promise((resolve, reject) => {
      console.log("BOWER: Pruning");
      child_process.exec("rm -rf bower_components", function(err) {
        if (err) {
          reject(Error(err));
        } else {
          resolve();
        }
      });
    });
  }

  /**
   * Installs the specified Bower package and analyses it for main html files in the bower.json,
   * returning a list of them via the promise.
   * @param {string} owner - the package owner
   * @param {string} repo - the package repository name
   * @param {string} version - the package version code
   * @return {Promise} a promise, returning a list of main html files found.
   */
  install(owner, repo, version) {
    var packageWithOwner = owner + "/" + repo;
    var packageToInstall = packageWithOwner + "#" + version;
    return new Promise((resolve, reject) => {
      console.log("BOWER: Installing " + packageToInstall);
      bower.commands.install([packageToInstall]).on('end', function(installed) {
        for (let bowerPackage in installed) {
          if (installed[bowerPackage].endpoint.source != packageWithOwner) {
            // Skip over dependencies (we're not interested in them)
            continue;
          }
          console.log("BOWER: Examining " + bowerPackage);

          var canonicalDir = installed[bowerPackage].canonicalDir;
          var mainHtmls = installed[bowerPackage].pkgMeta.main;
          if (!mainHtmls) {
            // TODO: Look in the directory and see what .html files we might be able to consume.
            reject(Error("Installed, but no main.html found"));
            return;
          }

          if (!Array.isArray(mainHtmls)) {
            mainHtmls = [mainHtmls];
          }

          resolve(mainHtmls.map(function(mainHtml) {
            return canonicalDir + "/" + mainHtml;
          }));
          return;
        }
        reject(Error("No matching packages were installed."));
      }).on('error', function(error) {
        reject(Error(error));
      });
    });
  }

  /**
   * Gathers transitive runtime dependencies for the given package as well as the
   * declared development dependencies (but not their dependencies).
   * The dependency list gathered should be enough to run any demos for the given
   * package.
   * Dependencies look like {name:string, owner:string, repo:string, version:string}.
   * @param {string} owner - the package owner
   * @param {string} repo - the package repository name
   * @param {string} version - the package version code
   * @return {Promise.<Array.<object>>} a promise, returning a list of dependency objects.
   */
  findDependencies(owner, repo, version) {
    var ownerPackageVersionString = owner + "/" + repo + "#" + version;
    console.log("BOWER: Finding transitive dependencies for " + ownerPackageVersionString);

    // The Bower API is pretty annoying. Unless the results are cached it will not reliably
    // report the github tag that it used to download the correct dependencies. In order
    // to make it do what we want, we need to do two dependency walks - one (online) to
    // populate the cache and another (offline) to gather the results.
    return Bower.dependencies(ownerPackageVersionString, {}, false).then(() => {
      return Bower.dependencies(ownerPackageVersionString, {}, true);
    });
  }

  static dependencies(ownerPackageVersionString, processed, offline) {
    return Bower.infoPromise(ownerPackageVersionString, offline).then((info) => {
      // Gather all of the dependencies we want to look at.
      var depsToProcess =
          Object.assign(info.dependencies ? info.dependencies : {},
          Object.keys(processed).length == 0 && info.devDependencies ? info.devDependencies : {});

      // Filter out what we've already processed.
      Object.keys(depsToProcess).forEach((key) => {
        if (processed[key]) {
          delete depsToProcess[key];
        }
      });

      var result = info.metadata ? [info.metadata] : [];

      var keys = Object.keys(depsToProcess);
      if (!keys.length) {
        return result;
      }

      // Analyse all of the dependencies we have left.
      var promises = keys.map((key) => {
        processed[key] = key;

        // Sanitize packages in ludicrous formats.
        var packageToProcess = depsToProcess[key];
        if (!packageToProcess.includes("/")) {
          packageToProcess = key + "#" + packageToProcess;
        }

        return Bower.dependencies(packageToProcess, processed, offline);
      });

      return Promise.all(promises).then((dependencyList) => [].concat.apply(result, dependencyList));
    });
  }

  static infoPromise(ownerPackageVersionString, offline) {
    return new Promise((resolve, reject) => {
      var metadata = null;
      bower.commands.info(
        ownerPackageVersionString,
        undefined /* property */,
        {
          offline: offline
        }
      ).on('end', function(info) {
        info.metadata = metadata;
        resolve(info);
      }).on('error', function(error) {
        console.error(error);
        resolve({});
      }).on('log', function(logEntry) {
        if (logEntry.id == 'cached' && logEntry.data && logEntry.data.pkgMeta &&
          logEntry.data.pkgMeta._resolution) {
          var owner, repo = "";
          // Our package strings look like "Owner/Repo#1.2.3"
          if (ownerPackageVersionString.includes("/")) {
            owner = ownerPackageVersionString;
            repo = owner.substring(owner.lastIndexOf("/") + 1, owner.lastIndexOf("#"));
            owner = owner.substring(0, owner.lastIndexOf("/"));
          } else {
            // These uris look like "git://github.com/Owner/Repo.git"
            owner = url.parse(logEntry.data.resolver.source).pathname;
            repo = owner.substring(owner.lastIndexOf("/") + 1, owner.lastIndexOf("."));
            owner = owner.substring(1 /* skip leading slash */, owner.lastIndexOf("/"));
          }
          metadata = {
            name: logEntry.data.pkgMeta.name,
            version: logEntry.data.pkgMeta._resolution.tag,
            owner: owner,
            repo: repo
          }
        }
      });
    });
  }
}

module.exports = {
  Bower: Bower
};
