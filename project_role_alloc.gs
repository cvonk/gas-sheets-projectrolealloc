/*                              CREATE A PIVOT TABLE
*                                      FOR
*                      ROLES ALLOCATIONS IN MULTIPLE PROJECTS
*
*                                   Coert Vonk
*                                 February 2019
*              https://github.com/cvonk/gas-sheets-project_role_alloc/
*
*
* DESCRIPTION:
*
* Create project role allocation pivot table based on projects names, users and
* their roles.
*
* USE:
*
* The names of tables at the far end of this code.
* Even if you don't ready anything else, please read through the examples below.
*
* DEPENDENCIES:
*
* Requires the Sheets API (otherwise you get: Reference error: Sheets is not
* defined).  To enable the API, refer to 
*   https://stackoverflow.com/questions/45625971/referenceerror-sheets-is-not-defined
* Note that this API has a default quota of 100 reads/day, after that it 
* throws an "Internal Error".
*
* EXAMPLES:
*
* Refer to https://github.com/cvonk/gas-sheets-projectrolealloc/blob/master/README.md
* 
* LEGAL:
*
* (c) Copyright 2019 by Coert Vonk
*
* This program is free software: you can redistribute it and/or modify
* it under the terms of the GNU General Public License as published by
* the Free Software Foundation, either version 3 of the License, or
* (at your option) any later version.
*
* This program is distributed in the hope that it will be useful,
* but WITHOUT ANY WARRANTY; without even the implied warranty of
* MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
* GNU General Public License for more details.
*
* You should have received a copy of the GNU General Public License
* along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

/***
 * @param {string[]} srcColumnLabels Labels of columns in the source sheet that will be output to the raw sheet (labels may include '*' as a wild chard character at the end)
 * @param {string}   srcSheetName    Name of the Source sheet that feeds the Raw sheet
 * @param {string}   rawSheetName    Name of the Raw sheet that feeds the Pivot Table
 * @param {string}   pvtSheetName    Name of the Pivot Table sheet
 * @param {string}   theSheetName    Optional parameter to map Project Names to overarching Theme Names
 */

function onPrjRoleAlloc(parameters) {

  // Maps each src column label (srcColumnLabels) to the corresponding column index
  // in the Src Sheet.  Two special conditions:
  //   1. If a label ends in '*', it matches any column in the src that starts with
  //      with that label.  E.g. (more about pct in expl.2)
  //        when 
  //          srcColumnLabels = ["Project Allocation*"]
  //          srcHeader = ["Project Allocation 1", "Project Allocation 2"]
  //        it will return
  //          [{label:"Project Allocation", idx:[{val:0, pct:-1}, {val:1, pct:-1}]}]
  //   2. If the src column has a corresponding column that ends in ' %", it is
  //      considered an assigned percentage for that column.  E.g.
  //        when 
  //          srcColumnLabels = ["Project Allocation*", "Username", "Role"]
  //          srcHeader = ["Username", "Preferred Name", "Person Type", "Role", "Project Allocation 1", "Project Allocation 1 %", "Project Allocation 2"]
  //        it will return
  //          [{label:"Project Allocation", idx:[{val:4, pct:5}, {val:6, pct:-1}]}, {label:"Username", idx:[{val:0, pct:-1}]}, {label:"Role", idx:[{val:3, pct:-1}]}]
  
  function _getSrcColumns(srcColumnLabels, srcHeader) {
    
    String.prototype.startsWith = function(prefix) { 
      return this.indexOf(prefix) === 0; 
    } 
    String.prototype.endsWith = function(suffix) { 
      return this.match(suffix+"$") == suffix; 
    };    
    
    var srcColumns = [];
    var percentageStr = " %";
    
    for each (var label in srcColumnLabels) {
      
      if (label.substr(-1) == "*") {
        label = label.slice(0, -1).trim();
      }
      var valueLabels = srcHeader.filter(function(srcLabel) {
        return srcLabel.startsWith(label) && !srcLabel.endsWith(percentageStr);
      });
      var srcColIdx = [];
      for each (var valueLabel in valueLabels) {
        srcColIdx.push({val:srcHeader.indexOf(valueLabel), pct:srcHeader.indexOf(valueLabel + percentageStr)});
      };
      srcColumns.push({label: label, idx:srcColIdx});
    }
    return srcColumns;
  }
  
  // Walk the srcColumns to determine the actions needed to create the Raw Sheet.
  // E.g. at the root level
  //   when 
  //     srcColumns = [{label:"Project Allocation", idx:[{val:4, pct:5}, {val:6, pct:-1}]}, 
  //                   {label:"Username", idx:[{val:0, pct:-1}]}, 
  //                   {label:"Role", idx:[{val:3, pct:-1}]}]
  //     action = []
  //     actions = []
  //   it returns
  //     [[{val:4, pct:5}, {val:0, pct:-1}, {val:3, pct:-1}], [{val:6, pct:-1}, {}, {}]]

  function _getActions(srcColumns, action, actions) {
    
    if (srcColumns.length == 0) {
      actions.push(action);
      return;
    }
    for each (var idx in srcColumns[0].idx) {
      var actioncopy = action.slice();
      actioncopy.push(idx);
      _getActions(srcColumns.slice(1), actioncopy, actions);
    }
    return actions;
  }
  
  // Returns the header row for the Raw Sheet
  // E.g.
  //   when
  //     srcColumnLabels = ["Project Allocation*", "Username", "Role"]
  //     theValues = [["Project", "Theme"],  ... ]
  //   it returns
  //     ["Theme", "Project Allocation%", "Project Allocation", "Username", "Role"]
  
  function _getRawHeader(srcColumnLabels, theValues) {
    
    var row = [];
    if (theValues != undefined) {
      row.push("Theme");
    }
    for each (var srcColumnLabel in srcColumnLabels) {
      
      var showRatio = srcColumnLabel.substr(-1) == "*";
      var lbl = srcColumnLabel;
      if (showRatio) {
        lbl = lbl.slice(0, -1);
        row.push(lbl.trim() + "%");
      }
      row.push(lbl.trim());
    }
    return row;
  }
  
  // Write the values from the Src Sheet to the Raw Sheet based on the actions
  // specified.
  // If an action level has multiple source columns, e.g. a user works on >1
  // project, divvy up their allocation.  E.g.
  //   when
  //     srcValues = [["jvonk", "Johan", "Employee", "Student", "School", 0.8, "Java"],
  //                  ["svonk", "Sander", "Employee", "Student", "School", "", "Reading"],
  //                  ["brlevins", "Barrie", "Employee", "Adult", "BoBo", "", ""]]
  //     actions = [[{val:4, pct:5}, {val:0, pct:-1}, {val:3, pct:-1}], [{val:6, pct:-1}, {}, {}]]
  //   it returns
  //     lines = [[, 0.8, "School", "jvonk", "Student"],
  //              [, 0.2, "Java", "jvonk", "Student"],
  //              [, 0.5, "School", "svonk", "Student"],
  //              [, 0.5, "Reading", "svonk", "Student"],
  //              [, 1, "BoBo", "brlevins", "Adult"]]
  
  function _getRawValues(srcValues, theValues, actions) {
    
    function __getRatio(srcRow, actions, idx, idxNr) {	    
      var assignedCnt = 0, assignedVal = 0, totalCnt = 0;
      for each (var act in actions) {        
        if (act[idxNr].pct >= 0) {
          var val = srcRow[act[idxNr].pct];
          if (val) { // skip blank
            assignedCnt++;
            assignedVal += val;
            if (assignedVal > 1) {
              throw("over 100% assigned for (" + srcRow[0]  + ")");
            }
          }
        }
        if (srcRow[act[idxNr].val]) {
          totalCnt++; // only count the columns with values
        }
      }
      if (assignedCnt) {
        if (idx.pct >= 0) {
          return srcRow[idx.pct];
        } else {
          return (1 - assignedVal) / (totalCnt - assignedCnt);
        }            
      }
      return 1.0 / totalCnt;
    }  
    
    function __getActionIdxsThatHaveAssignedPercentages(srcValues, actions, idx) {
      var result = [];
      for each (var srcRow in srcValues) {
        for each (var action in actions) {  
          var actionLvl = 0;
          for each (var idx in action) {
            if (idx.pct >= 0 && srcRow[idx.pct]) {
              result.push(actionLvl);
            }
            actionLvl++;
          }
        }
      }
      return result;
    }
   
    function __getActionLvlsSources(actions) {
      var result = [];
      for each (action in actions) {
        for (ii = 0; ii < action.length; ii++) {
          var idx = action[ii];
          if (result[ii] == undefined) {
            result[ii] = [];
          }  
          if (result[ii].indexOf(idx.val) < 0) {
              result[ii].push(idx.val);
          }
        }          
      }
      return result;
    }
    
    function __getTheme(theValues, prjName) {
      for each (var row in theValues) {
        if (row[0] == prjName) {
          return row[1];
        }
      }
      return undefined;
    }

    var lines = [];
    var actionLvlsSources = __getActionLvlsSources(actions);    
    
    var rowNr = 1;
    for each (var srcRow in srcValues) {
      
      for each (var action in actions) {
        
        var row = [], alloc = 1, idxNr = 0;
        if (theValues != undefined) {
          row.push(__getTheme(theValues, srcRow[action[0].val]));
        }
        for each (var idx in action) {
          var ratio = __getRatio(srcRow, actions, idx, idxNr);
          
          if (actionLvlsSources[idxNr].length > 1) {     // 2BD
            row.push(Number(ratio.toFixed(2)));  // hide math precision err
          }
          row.push(srcRow[idx.val]);
          idxNr++;
        }
        
        var cellsWithValues = row.filter(function(val) {
          return val != "";
        });
        if (cellsWithValues.length == row.length) {
          lines.push(row);
          rowNr++;
        }
      }
    }
    return lines;
  }
  
  // Enable the Sheets API, or you get: Reference error: sheets is not defined
  // https://stackoverflow.com/questions/45625971/referenceerror-sheets-is-not-defined
  function _createPivotTable(spreadsheet, srcColumnLabels, rawHeader, rawSheet, pvtSheetName, theValues) {
    
    if (srcColumnLabels.length < 3) {
      return;
    }
    
    var pivotTblSheet = spreadsheet.insertSheet(pvtSheetName);

/*    
    // conditional formatting
    var myRange = {
      "sheetId": pivotTblSheet.getSheetId(),
      "startRowIndex": 0,
      "endRowIndex": 50,
      "startColumnIndex": 0,
      "endColumnIndex": 10
    };

    var requests = [
      {
        'addConditionalFormatRule': {
          'index': 0,
          'rule': { 
            'ranges': [myRange],
            "booleanRule": {
              "condition": {
                "type": "CUSTOM_FORMULA",
                "values": [{"userEnteredValue": "=AND(MATCH(RIGHT(OFFSET($A$1,ROW()-1,0),5), \"Total\"), NOT(ISBLANK(OFFSET($A$1,1,COLUMN()-1))))"}]
              },
              "format": {
                "backgroundColor": {
                  "red": 0.7176471,
                  "green": 0.88235295,
                  "blue": 0.8039216
                }
              }
            }
          }
        }
      },
      {
        'addConditionalFormatRule': {
          'index': 0,
          'rule': { 
            'ranges': [myRange],
            "booleanRule": {
              "condition": {
                "type": "CUSTOM_FORMULA",
                "values": [{"userEnteredValue": "=AND(MATCH(OFFSET($A$1,ROW()-1,0), \"Theme\"), NOT(ISBLANK(OFFSET($A$1,1,COLUMN()-1))))"}]
              },
              "format": {
                "backgroundColor": {"red": 0.95686275, "green": 0.78039217, "blue": 0.7647059
                                   }
              }
            }
          }
        }
      }];
    
    var dbg = Sheets.Spreadsheets.batchUpdate({"requests": requests}, spreadsheet.getId());
*/

    // add pivot table
    //
    // the raw (optionally) starts with a theme column => that goes in the first pivot row
    // the last raw column => that goes to the pivot values
    // remaining raw columns => go as pivot rows
    var hasTheme = theValues != undefined;
    var valCol = hasTheme ? 1 : 0;
    var colIdx = rawHeader.length - 1;
    var rowIdxStart = valCol + 1;
    var rowIdxEnd = colIdx - 1;
    
    // API details at https://developers.google.com/sheets/api/reference/rest/v4/spreadsheets/pivot-tables
    var cfg = {
      "source": {
        sheetId: rawSheet.getSheetId(),
        endRowIndex: rawSheet.getDataRange().getNumRows(),
        endColumnIndex: rawSheet.getDataRange().getNumColumns()
      },
      "rows": [],
      "columns": [{
        sourceColumnOffset: colIdx,
        showTotals: true,
        sortOrder: "ASCENDING"
      }],
      "values": [{
        sourceColumnOffset: valCol,
        summarizeFunction: "SUM"
      }]
    };
    if (hasTheme) {
      cfg.rows.push({
        sourceColumnOffset: 0,
        showTotals: true,  //label: "Something else instead of Theme",
        sortOrder: "ASCENDING"
      });
    }
    for (var ii = rowIdxStart; ii <= rowIdxEnd; ii++) {
      cfg.rows.push({
        sourceColumnOffset: ii,
        showTotals: true,
        sortOrder: "ASCENDING"
      });
    }

    var request = [{
      "updateCells": {
        "rows": {
          "values": [{
            "pivotTable": cfg
          }]
        },
        "start": {
          "sheetId": pivotTblSheet.getSheetId()
        },
        "fields": "pivotTable"
      }
    }];
    return Sheets.Spreadsheets.batchUpdate({"requests": request}, spreadsheet.getId());
  }
  
  // Updates the source range for the pivot table.
  // Instead of supplying a whole new pivot table, use the API to get the configuration
  // of the exising Pivot Table, and update the source range
  
  function _updatePivotTable(spreadsheet, rawSheet, pvtSheet, pvtSheetName) {
    
    var pvtTableSheetId = pvtSheet.getSheetId();
    
    
    try {
      var response = Sheets.Spreadsheets.get(spreadsheet.getId(), {
        ranges: pvtSheetName,
        fields: "sheets.data.rowData.values.pivotTable"
      });
    } catch (e) {
      if (response == undefined) {  // Internal Error? > you exceeded your quota? (dflt 100 reads/day)
        throw("Google Sheets API read quota exceeded");
      }
    }
    
    var cfg = response.sheets[0].data[0].rowData[0].values[0].pivotTable;
    cfg.source.endRowIndex = rawSheet.getDataRange().getNumRows();
    
    var request = {
      "updateCells": {
        "rows": {
          "values": [{
            "pivotTable": cfg
          }]
        },
        "start": {
          "sheetId": pvtTableSheetId
        },
        "fields": "pivotTable"
      }
    };
    
    Sheets.Spreadsheets.batchUpdate({"requests": [request]}, spreadsheet.getId());
  }

  // validate parameters
  
  if (parameters.srcColumnLabels == undefined ||
      parameters.srcSheetName == undefined ||
      parameters.pvtSheetName == undefined) {
    throw("invalid parameters to onPrjRoleAlloc()");
  }
  if (typeof parameters.srcColumnLabels !== "object" ||
      typeof parameters.srcSheetName !== "string" ||
      typeof parameters.pvtSheetName !== "string" ) {
    throw("invalid parameters type to onPrjRoleAlloc()");
  }

  // open sheets; copy values
  
  var spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  
  var srcSheet = Common.sheetOpen(spreadsheet, parameters.srcSheetName, 2, true );
  var srcValues = Common.getFilteredDataRange(srcSheet);
  var srcHeader = srcValues.shift();
  
  var rawSheetName = parameters.pvtSheetName + "-raw";
  var rawSheet = Common.sheetCreate(spreadsheet, rawSheetName, true).clear();
  
  var theValues = undefined;
  if (parameters.theSheetName != undefined) {
    var theSheet = Common.sheetOpen(spreadsheet, parameters.theSheetName, 2, true );
    theValues = Common.getFilteredDataRange(theSheet);
  }
  
  // create an array of actions
  // each action is a list of cells to copy from the Source Sheet
  
  var srcColumns = _getSrcColumns(parameters.srcColumnLabels, srcHeader);
  var actions = _getActions(srcColumns, [], []);
  
  // write the raw sheet (that drives the pivot table later)
  
  var rawHeader = _getRawHeader(parameters.srcColumnLabels, theValues);
  var rawValues = _getRawValues(srcValues, theValues, actions);
  var rawData = [rawHeader].concat(rawValues);
  rawSheet.getRange(1, 1, rawData.length, rawData[0].length).setValues(rawData);
  
  // update the pivot table (create if necessary)
  
  if (spreadsheet.getSheetByName(parameters.pvtSheetName) == null) {
    _createPivotTable(spreadsheet, parameters.srcColumnLabels, rawHeader, rawSheet, parameters.pvtSheetName, theValues);
  } else {
    _updatePivotTable(spreadsheet, rawSheet, spreadsheet.getSheetByName(parameters.pvtSheetName), parameters.pvtSheetName);
  }      
}

function onPrjRoleAlloc_dbg() {
  onPrjRoleAlloc({srcColumnLabels: ["Project Allocation*", "Username", "Role" ],
                  srcSheetName: "persons",
                  pvtSheetName: "role-alloc",
                  theSheetName: "themes"});
}

